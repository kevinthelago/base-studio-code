// layers (#2214, graph-core epic) — the shared longest-path layerer used by Glance + the relationship
// graph. Direction is "from → deeper" (a node points at the nodes that sit below it).
import { describe, it, expect } from "vitest";
import { layerDag } from "./layers";
import type { GraphEdge } from "./types";

describe("layerDag (#2214)", () => {
  it("assigns longest-path layers over a chain", () => {
    const edges: GraphEdge[] = [
      { id: "e1", from: "a", to: "b" },
      { id: "e2", from: "b", to: "c" },
    ];
    expect(layerDag(["a", "b", "c"], edges)).toEqual({ a: 0, b: 1, c: 2 });
  });

  it("takes the LONGEST path, not the shortest (a→c direct + a→b→c → c at 2)", () => {
    const edges: GraphEdge[] = [
      { id: "e1", from: "a", to: "b" },
      { id: "e2", from: "b", to: "c" },
      { id: "e3", from: "a", to: "c" },
    ];
    expect(layerDag(["a", "b", "c"], edges).c).toBe(2);
  });

  it("is independent of edge order (unique DAG fixpoint)", () => {
    const forward: GraphEdge[] = [
      { id: "e1", from: "a", to: "b" },
      { id: "e2", from: "b", to: "c" },
      { id: "e3", from: "a", to: "c" },
    ];
    const shuffled = [forward[2], forward[0], forward[1]];
    expect(layerDag(["a", "b", "c"], shuffled)).toEqual(layerDag(["a", "b", "c"], forward));
  });

  it("keeps isolated nodes at layer 0", () => {
    const edges: GraphEdge[] = [{ id: "e1", from: "a", to: "b" }];
    expect(layerDag(["a", "b", "lonely"], edges).lonely).toBe(0);
  });

  it("excludes back-edges so a cycle can't diverge the layout", () => {
    const edges: GraphEdge[] = [
      { id: "e1", from: "a", to: "b" },
      { id: "e2", from: "b", to: "c" },
      { id: "e3", from: "c", to: "a" }, // the back-edge closing a→b→c→a
    ];
    const layer = layerDag(["a", "b", "c"], edges, new Set(["e3"]));
    expect(layer).toEqual({ a: 0, b: 1, c: 2 });
  });

  it("ignores self-loops and edges touching an unknown node", () => {
    const edges: GraphEdge[] = [
      { id: "self", from: "a", to: "a" },
      { id: "e1", from: "a", to: "b" },
      { id: "ghost", from: "b", to: "phantom" },
    ];
    expect(layerDag(["a", "b"], edges)).toEqual({ a: 0, b: 1 });
  });

  it("reversed edges give the depends-on orientation (dependency lands at a lower layer)", () => {
    // Glance's convention: an edge `dependent → dependency` should put the dependency LOWER. Reversing
    // the edge before calling does exactly that.
    const depends: GraphEdge[] = [
      { id: "e1", from: "web", to: "api" }, // web depends on api
      { id: "e2", from: "api", to: "core" }, // api depends on core
    ];
    const reversed = depends.map((e) => ({ id: e.id, from: e.to, to: e.from }));
    const layer = layerDag(["web", "api", "core"], reversed);
    expect(layer).toEqual({ core: 0, api: 1, web: 2 });
  });
});
