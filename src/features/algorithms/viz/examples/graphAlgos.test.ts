// Graph trace-programs (#3224) — BFS visits in breadth-first order and reaches every connected node (so
// the animation is faithful), and the adjacency-list parser round-trips.
import { describe, it, expect } from "vitest";
import { TracedGraph, type GraphInput } from "../../lib/tracer";
import { bfs, dfs, dijkstra, aStar, topologicalSort, GRAPH_PROGRAMS, parseGraphInput, graphToText } from "./graphAlgos";
import type { GraphFrame } from "../../lib/trace";

const G: GraphInput = {
  nodes: ["a", "b", "c", "d", "e", "f"].map((id) => ({ id })),
  edges: [
    { from: "a", to: "b" },
    { from: "a", to: "c" },
    { from: "b", to: "d" },
    { from: "c", to: "d" },
    { from: "c", to: "e" },
    { from: "d", to: "f" },
    { from: "e", to: "f" },
  ],
};

function frames(algo: (g: TracedGraph) => void, input: GraphInput): GraphFrame[] {
  const g = new TracedGraph(input);
  algo(g);
  return g.trace();
}

describe("bfs (#3224)", () => {
  it("visits in breadth-first order from the first node", () => {
    const visits = frames(bfs, G).flatMap((f) => f.ops ?? []).filter((o) => o.op === "visit").map((o) => (o as { node: string }).node);
    expect(visits).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("marks every reachable node visited by the end", () => {
    const fs = frames(bfs, G);
    const marks = fs[fs.length - 1].marks ?? {};
    expect(G.nodes.every((n) => marks[n.id] === "visited")).toBe(true);
  });

  it("emits frontier + relax verbs (the wavefront expands along edges)", () => {
    const ops = frames(bfs, G).flatMap((f) => f.ops ?? []);
    expect(ops.some((o) => o.op === "frontier")).toBe(true);
    expect(ops.some((o) => o.op === "relax")).toBe(true);
  });

  it("GRAPH_PROGRAMS registers the family keyed by base name", () => {
    expect(GRAPH_PROGRAMS.bfs.run).toBe(bfs);
    expect(GRAPH_PROGRAMS.dfs.run).toBe(dfs);
    expect(GRAPH_PROGRAMS.dijkstra.run).toBe(dijkstra);
    expect(GRAPH_PROGRAMS["a-star"].run).toBe(aStar);
    expect(GRAPH_PROGRAMS["topological-sort"].run).toBe(topologicalSort);
  });
});

const visitOrder = (fs: GraphFrame[]) =>
  fs.flatMap((f) => f.ops ?? []).filter((o) => o.op === "visit").map((o) => (o as { node: string }).node);

describe("dfs / dijkstra / topological-sort (#3226)", () => {
  it("dfs visits depth-first (distinct from bfs's level order)", () => {
    expect(visitOrder(frames(dfs, G))).toEqual(["a", "b", "d", "c", "e", "f"]);
    expect(visitOrder(frames(bfs, G))).not.toEqual(visitOrder(frames(dfs, G)));
  });

  it("dijkstra visits by distance and lights the shortest path a→f", () => {
    const g = GRAPH_PROGRAMS.dijkstra.defaultInput;
    const fs = frames(dijkstra, g);
    const pathOp = fs.flatMap((f) => f.ops ?? []).find((o) => o.op === "path") as { nodes: string[] } | undefined;
    expect(pathOp?.nodes).toEqual(["a", "c", "b", "d", "e", "f"]); // the shortest route (total weight 13)
  });

  it("topological-sort produces a valid order (every directed edge points forward)", () => {
    const g = GRAPH_PROGRAMS["topological-sort"].defaultInput;
    const order = visitOrder(frames(topologicalSort, g));
    expect(order.length).toBe(g.nodes.length);
    const rank = new Map(order.map((id, i) => [id, i]));
    expect(g.edges.every((e) => (rank.get(e.from) ?? 0) < (rank.get(e.to) ?? 0))).toBe(true);
  });

  it("a-star finds the shortest path and explores fewer nodes than Dijkstra (heuristic guides it)", () => {
    const g = GRAPH_PROGRAMS["a-star"].defaultInput;
    const fs = frames(aStar, g);
    const pathOp = fs.flatMap((f) => f.ops ?? []).find((o) => o.op === "path") as { nodes: string[] } | undefined;
    expect(pathOp?.nodes).toEqual(["a", "b", "d", "g"]); // the shortest route
    expect(visitOrder(fs).length).toBeLessThan(visitOrder(frames(dijkstra, g)).length); // pruned
  });
});

describe("TracedGraph directed helpers (#3226)", () => {
  it("outNeighbours is directed (from→to only); inDegrees counts incoming edges", () => {
    const g = new TracedGraph({
      nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
        { from: "b", to: "c" },
      ],
    });
    expect(g.outNeighbours("a").map((n) => n.to).sort()).toEqual(["b", "c"]);
    expect(g.outNeighbours("c")).toEqual([]); // c has no outgoing edges
    const indeg = g.inDegrees();
    expect(indeg.get("a")).toBe(0);
    expect(indeg.get("b")).toBe(1);
    expect(indeg.get("c")).toBe(2);
  });
});

describe("parseGraphInput / graphToText (#3224)", () => {
  it("parses an adjacency list into nodes + undirected deduped edges", () => {
    const g = parseGraphInput("a: b, c\nb: d\nc: d");
    expect(g.nodes.map((n) => n.id)).toEqual(["a", "b", "c", "d"]); // first-appearance order
    // a-b, a-c, b-d, c-d — 4 undirected edges, b-d and c-d not duplicated by their reverse.
    expect(g.edges.length).toBe(4);
  });

  it("dedups an edge listed from both endpoints", () => {
    const g = parseGraphInput("a: b\nb: a");
    expect(g.edges.length).toBe(1);
  });

  it("round-trips a graph through graphToText → parseGraphInput (same edge set)", () => {
    const text = graphToText(G);
    const back = parseGraphInput(text);
    const key = (e: { from: string; to: string }) => [e.from, e.to].sort().join("~");
    expect(new Set(back.edges.map(key))).toEqual(new Set(G.edges.map(key)));
  });

  it("rejects empty input", () => {
    expect(() => parseGraphInput("   ")).toThrow(/adjacency list/i);
  });
});
