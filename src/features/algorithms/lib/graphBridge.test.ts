import { describe, it, expect, vi, beforeEach } from "vitest";

const bscJson = vi.fn();
vi.mock("@/shared/lib/core/bsc", () => ({ bscJson: (...a: unknown[]) => bscJson(...a) }));

import { loadGraph } from "./graphBridge";

describe("graphBridge.loadGraph (#2856)", () => {
  beforeEach(() => bscJson.mockReset());

  it("builds the impl-only model from a valid `bsc graph dump` doc (#2961)", async () => {
    bscJson.mockResolvedValue({
      implementations: [
        { id: "merge.rs", tech: "rust", role: "algorithm", name: "merge (Rust)", composes: [], code: "fn merge() {}" },
      ],
    });
    const g = await loadGraph();
    expect(g).not.toBeNull();
    expect(g!.implementations[0]).toMatchObject({ id: "merge.rs", role: "algorithm" });
    // It called the dump verb, not project-scoped.
    expect(bscJson).toHaveBeenCalledWith(null, ["graph", "dump"], null);
  });

  it("accepts an empty implementations array", async () => {
    bscJson.mockResolvedValue({ implementations: [] });
    expect((await loadGraph())!.implementations).toEqual([]);
  });

  it("returns null when implementations isn't an array (degraded → keep the seed)", async () => {
    bscJson.mockResolvedValue({ implementations: "nope" });
    expect(await loadGraph()).toBeNull();
  });

  it("returns null when the bridge yields null (unreachable / old bsc without the verb)", async () => {
    bscJson.mockResolvedValue(null);
    expect(await loadGraph()).toBeNull();
  });

  it("returns null when the bridge throws", async () => {
    bscJson.mockRejectedValue(new Error("no bridge"));
    expect(await loadGraph()).toBeNull();
  });
});
