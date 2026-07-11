import { describe, it, expect, vi, beforeEach } from "vitest";

const bscJson = vi.fn();
vi.mock("@/shared/lib/core/bsc", () => ({ bscJson: (...a: unknown[]) => bscJson(...a) }));

import { loadGraph } from "./graphBridge";

describe("graphBridge.loadGraph (#2856)", () => {
  beforeEach(() => bscJson.mockReset());

  it("builds the model from a valid `bsc graph dump` doc, stamping provenance", async () => {
    bscJson.mockResolvedValue({
      nodes: [{ id: "array", kind: "data-structure", name: "Array", summary: "cells" }],
      edges: [{ from: "merge-sort", to: "array", rel: "operates-on" }],
      implementations: [],
    });
    const g = await loadGraph();
    expect(g).not.toBeNull();
    expect(g!.nodes[0]).toMatchObject({ id: "array", provenance: "seed" });
    expect(g!.edges).toHaveLength(1);
    // It called the dump verb, not project-scoped.
    expect(bscJson).toHaveBeenCalledWith(null, ["graph", "dump"], null);
  });

  it("defaults a missing `implementations` to []", async () => {
    bscJson.mockResolvedValue({ nodes: [], edges: [] });
    expect((await loadGraph())!.implementations).toEqual([]);
  });

  it("returns null when nodes/edges aren't arrays (degraded → keep the seed)", async () => {
    bscJson.mockResolvedValue({ nodes: "nope", edges: [] });
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
