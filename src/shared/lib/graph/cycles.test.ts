// cycles (#2217, graph-core epic #2214) — shared cycle detection: DFS back-edges (any-length) + the
// 2-cycle mutual-pair special case.
import { describe, it, expect } from "vitest";
import { findBackEdges, mutualPairs } from "./cycles";
import type { GraphEdge } from "./types";

describe("findBackEdges (#2217)", () => {
  it("finds no back-edge in a DAG", () => {
    const edges: GraphEdge[] = [
      { id: "e1", from: "a", to: "b" },
      { id: "e2", from: "b", to: "c" },
      { id: "e3", from: "a", to: "c" },
    ];
    const r = findBackEdges(["a", "b", "c"], edges);
    expect(r.hasCycle).toBe(false);
    expect(r.backEdgeIds.size).toBe(0);
  });

  it("flags the closing edge of a 3-cycle (any length, not just pairs)", () => {
    const edges: GraphEdge[] = [
      { id: "e1", from: "a", to: "b" },
      { id: "e2", from: "b", to: "c" },
      { id: "e3", from: "c", to: "a" }, // closes a→b→c→a
    ];
    const r = findBackEdges(["a", "b", "c"], edges);
    expect(r.hasCycle).toBe(true);
    expect([...r.backEdgeIds]).toEqual(["e3"]);
  });

  it("flags a mutual pair as a back-edge too", () => {
    const edges: GraphEdge[] = [
      { id: "e1", from: "a", to: "b" },
      { id: "e2", from: "b", to: "a" },
    ];
    const r = findBackEdges(["a", "b"], edges);
    expect(r.hasCycle).toBe(true);
    expect(r.backEdgeIds.size).toBe(1); // one direction is the back-edge
  });

  it("ignores edges whose endpoints aren't in nodeIds", () => {
    const edges: GraphEdge[] = [
      { id: "e1", from: "a", to: "b" },
      { id: "e2", from: "b", to: "ghost" },
    ];
    const r = findBackEdges(["a", "b"], edges);
    expect(r.hasCycle).toBe(false);
  });
});

describe("mutualPairs (#2217)", () => {
  it("returns each a↔b pair once (from < to) with both edge ids + node ids", () => {
    const edges: GraphEdge[] = [
      { id: "e1", from: "a", to: "b" },
      { id: "e2", from: "b", to: "a" },
      { id: "e3", from: "b", to: "c" }, // one-way, not mutual
    ];
    const r = mutualPairs(edges);
    expect(r.pairs).toEqual([["a", "b"]]);
    expect([...r.edgeIds].sort()).toEqual(["e1", "e2"]);
    expect([...r.nodeIds].sort()).toEqual(["a", "b"]);
  });

  it("finds nothing when there is no bidirectional pair", () => {
    const edges: GraphEdge[] = [
      { id: "e1", from: "a", to: "b" },
      { id: "e2", from: "b", to: "c" },
    ];
    const r = mutualPairs(edges);
    expect(r.pairs).toEqual([]);
    expect(r.edgeIds.size).toBe(0);
  });
});
