import { describe, it, expect, vi, beforeEach } from "vitest";

// #4078 — the read moved IN-PROCESS (`graph_dump`), off the spawning `bsc` bridge. Mocking
// `safeInvoke` rather than `bscJson` is the point: a revert to the bridge would fail these outright
// instead of quietly restoring a process spawn every 5s.
const safeInvoke = vi.fn();
vi.mock("@/shared/lib/core/safeInvoke", () => ({ safeInvoke: (...a: unknown[]) => safeInvoke(...a) }));

import { loadGraph } from "./graphBridge";

describe("graphBridge.loadGraph (#2856)", () => {
  // Block body, NOT the concise `() => bscJson.mockReset()` (#3390): `mockReset()` RETURNS the mock, and
  // vitest treats a function returned from `beforeEach` as an after-each TEARDOWN and invokes it. That
  // stray invocation ran whatever implementation the test had installed — so the rejecting test below
  // produced a second, unawaited rejected promise, and the resulting UNHANDLED rejection failed a test
  // whose assertion had actually passed.
  beforeEach(() => {
    safeInvoke.mockReset();
  });

  it("builds the impl-only model from a valid graph doc (#2961)", async () => {
    safeInvoke.mockResolvedValue({
      implementations: [
        { id: "merge.rs", tech: "rust", role: "algorithm", name: "merge", composes: [], code: "fn merge() {}" },
      ],
    });
    const g = await loadGraph();
    expect(g).not.toBeNull();
    expect(g!.implementations[0]).toMatchObject({ id: "merge.rs", role: "algorithm" });
    // It read IN-PROCESS (#4078) — never the spawning bridge.
    expect(safeInvoke).toHaveBeenCalledWith("graph_dump", undefined, null);
  });

  it("accepts an empty implementations array", async () => {
    safeInvoke.mockResolvedValue({ implementations: [] });
    expect((await loadGraph())!.implementations).toEqual([]);
  });

  it("returns null when implementations isn't an array (degraded → keep the seed)", async () => {
    safeInvoke.mockResolvedValue({ implementations: "nope" });
    expect(await loadGraph()).toBeNull();
  });

  it("returns null when the read yields null (unavailable command / web shell)", async () => {
    safeInvoke.mockResolvedValue(null);
    expect(await loadGraph()).toBeNull();
  });

  it("returns null when the read throws", async () => {
    safeInvoke.mockRejectedValue(new Error("no command"));
    expect(await loadGraph()).toBeNull();
  });
});
