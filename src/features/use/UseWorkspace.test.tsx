// The USE layer's screen (`the-use-layer-gets-a-screen`).
//
// The assertions that matter here are about FRESHNESS, not layout. A screen that renders a stale
// reading as though it were current is the exact failure `docs/llm-operator/context.md` shipped for
// seven weeks, and it is invisible in a render test that only checks the text appears.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { presented, isFresh, flatten, BUDGET_MS, type NetworkCapabilities } from "@/features/use/UseWorkspace";

const { calls } = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock("@/shared/lib/core/bsc", () => ({
  bsc: vi.fn(),
  bscJson: vi.fn(async (_k: string | null, args: string[], fallback: unknown) => {
    calls.push(args);
    if (args[1] === "networks") return [{ network: "network-finance", projects: 2, capabilities: 1 }];
    if (args[1] === "get") {
      return {
        network: "network-finance",
        shared: [{ id: "device:lumpy-space", kind: "device", name: "lumpy-space", how: "bsc deploy status lumpy-space", observed: { state: "current", at_ms: Date.now() } }],
        projects: [],
      } as NetworkCapabilities;
    }
    return fallback;
  }),
}));

import { UseWorkspace } from "@/features/use/UseWorkspace";

const NOW = 1_000_000_000;

beforeEach(() => { calls.length = 0; });

describe("the screen applies the SAME freshness rule the read does", () => {
  it("shows a recent reading's state", () => {
    expect(presented({ state: "current", at_ms: NOW - 1000 }, NOW)).toBe("current");
    expect(isFresh({ state: "current", at_ms: NOW - 1000 }, NOW)).toBe(true);
  });

  it("shows unknown for a reading past its budget — never its last value", () => {
    const stale = { state: "current", at_ms: NOW - BUDGET_MS - 1 };
    expect(presented(stale, NOW)).toContain("unknown");
    expect(presented(stale, NOW)).not.toContain("current");
    expect(isFresh(stale, NOW)).toBe(false);
  });

  it("keeps stale and never-observed distinct, as the read does", () => {
    // Different next moves: one says look again, the other says nothing has ever looked.
    expect(presented({ state: "current", at_ms: NOW - BUDGET_MS - 1 }, NOW))
      .not.toBe(presented({ state: "" }, NOW));
    expect(presented({ state: "" }, NOW)).toContain("never observed");
  });

  it("uses the SAME budget as the Rust read", () => {
    // Pinned because the two live in different languages. A screen that believed a reading LONGER
    // than the read does would render, as current, a value the session was already told to distrust.
    expect(BUDGET_MS).toBe(5 * 60 * 1000);
  });

  it("treats exactly-at-the-budget as fresh, matching the read's boundary", () => {
    expect(isFresh({ state: "current", at_ms: NOW - BUDGET_MS }, NOW)).toBe(true);
  });
});

describe("flatten mirrors the read's row order", () => {
  it("puts network-wide capabilities before project-owned ones", () => {
    const c: NetworkCapabilities = {
      network: "n",
      shared: [{ id: "s", kind: "device", name: "shared", how: "", observed: { state: "x", at_ms: NOW } }],
      projects: [{ project: "p", capabilities: [{ id: "o", kind: "surface", name: "owned", how: "", observed: { state: "y", at_ms: NOW } }] }],
    };
    expect(flatten(c).map((r) => r.cap.id)).toEqual(["s", "o"]);
  });

  it("a null read is no rows rather than a crash", () => {
    expect(flatten(null)).toEqual([]);
  });
});

describe("the screen reads the capability surface and nothing else", () => {
  it("calls `bsc capability`, never its own query", async () => {
    // THE LOAD-BEARING CONSTRAINT. The same read serialises as a steward's context, so a second query
    // here is how the screen and the session come to disagree.
    render(<UseWorkspace />);
    await screen.findByText(/what this app has finished/i);
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    for (const c of calls) {
      expect(c[0], `the screen ran \`bsc ${c.join(" ")}\` — it may only read \`capability\``).toBe("capability");
    }
  });

  it("renders a capability with the command that drives it", async () => {
    render(<UseWorkspace />);
    expect(await screen.findByText("lumpy-space")).toBeTruthy();
    expect(await screen.findByText("bsc deploy status lumpy-space")).toBeTruthy();
  });
});
