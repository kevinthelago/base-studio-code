// Graph trace-programs (#3224) — BFS visits in breadth-first order and reaches every connected node (so
// the animation is faithful), and the adjacency-list parser round-trips.
import { describe, it, expect } from "vitest";
import { TracedGraph, type GraphInput } from "../../lib/tracer";
import { bfs, GRAPH_PROGRAMS, parseGraphInput, graphToText } from "./graphAlgos";
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

  it("GRAPH_PROGRAMS registers bfs keyed by base name", () => {
    expect(GRAPH_PROGRAMS.bfs.run).toBe(bfs);
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
