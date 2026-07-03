// neighborSpotlight (#2215, graph-core epic #2214) — the shared focus primitive Glance + the
// relationship graph both build their node/agent spotlight on.
import { describe, it, expect } from "vitest";
import { neighborSpotlight } from "./spotlight";
import type { GraphEdge } from "./types";

const edges: GraphEdge[] = [
  { id: "e1", from: "a", to: "b" },
  { id: "e2", from: "b", to: "c" },
  { id: "e3", from: "d", to: "a" },
];

describe("neighborSpotlight (#2215)", () => {
  it("lights the focus node, its neighbors in either direction, and the touching edges", () => {
    const sp = neighborSpotlight(edges, "a");
    expect([...sp.litNodes].sort()).toEqual(["a", "b", "d"]); // a + out-neighbor b + in-neighbor d
    expect([...sp.litEdges].sort()).toEqual(["e1", "e3"]);
  });

  it("always includes the focus node even when it has no edges", () => {
    const sp = neighborSpotlight(edges, "z");
    expect([...sp.litNodes]).toEqual(["z"]);
    expect(sp.litEdges.size).toBe(0);
  });

  it("collects both incident edges for a node in the middle of a chain", () => {
    const sp = neighborSpotlight(edges, "b");
    expect([...sp.litNodes].sort()).toEqual(["a", "b", "c"]);
    expect([...sp.litEdges].sort()).toEqual(["e1", "e2"]);
  });
});
