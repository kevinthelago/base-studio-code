// Graph traversal / shortest-path trace-programs (#3224, epic #3220/#3215) — real algorithms written over
// a TracedGraph, so the animation is DERIVED from the traversal's own execution: the frontier expands,
// nodes turn visited, edges relax. BFS is the proof; dfs / dijkstra / a-star / topological-sort follow.
// Keyed by base name (bfs.rs → bfs), so the existing Rust graph impls animate via their JS trace-program.
import type { TracedGraph, GraphInput } from "../../lib/tracer";

/** A visualizable graph algorithm — its real logic over a {@link TracedGraph} + the graph to seed it. */
export interface GraphProgram {
  run: (g: TracedGraph) => void;
  defaultInput: GraphInput;
}

/** A small, connected example graph (6 nodes) — legible under the renderer's circular layout, and shows a
 *  clear BFS wavefront from `a`. */
const DEFAULT_GRAPH: GraphInput = {
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

/** Breadth-first search from the first node — a queue expands the frontier level by level; each dequeued
 *  node is visited and its undiscovered neighbours are relaxed + enqueued. The visit order is BFS order. */
export function bfs(g: TracedGraph): void {
  const ids = g.ids();
  if (ids.length === 0) return;
  const start = ids[0];
  const seen = new Set<string>([start]);
  const queue: string[] = [start];
  g.frontier(start);
  while (queue.length > 0) {
    const node = queue.shift() as string;
    g.visit(node);
    for (const nb of g.neighbours(node)) {
      if (!seen.has(nb.to)) {
        seen.add(nb.to);
        g.relax(node, nb.to);
        g.frontier(nb.to);
        queue.push(nb.to);
      }
    }
  }
}

/** The visualizable graph algorithms, keyed by base name. BFS today (#3224); the rest of the family follows. */
export const GRAPH_PROGRAMS: Record<string, GraphProgram> = {
  bfs: { run: bfs, defaultInput: DEFAULT_GRAPH },
};

/** Serialize a graph to an adjacency-list text (undirected, each edge listed under its first endpoint). */
export function graphToText(input: GraphInput): string {
  const out = new Map<string, string[]>();
  for (const n of input.nodes) out.set(n.id, []);
  for (const e of input.edges) out.get(e.from)?.push(e.to);
  return input.nodes
    .filter((n) => (out.get(n.id) ?? []).length > 0)
    .map((n) => `${n.id}: ${(out.get(n.id) ?? []).join(", ")}`)
    .join("\n");
}

/**
 * Parse the "your input" text into a graph — an adjacency list, one node per line (`a: b, c`), rows split
 * by newline or `;`, neighbours by comma/space. Edges are UNDIRECTED (deduped). Throws a helpful `Error`
 * on empty or oversized input. Node order follows first appearance (the BFS start is the first node).
 */
export function parseGraphInput(text: string): GraphInput {
  const lines = text.split(/[\n;]/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) throw new Error("Enter an adjacency list, e.g. a: b, c");
  const order: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  };
  const edgeKeys = new Set<string>();
  const edges: { from: string; to: string }[] = [];
  for (const line of lines) {
    const [head, rest = ""] = line.split(":");
    const from = head.trim();
    if (!from) continue;
    add(from);
    for (const to of rest.split(/[\s,]+/).map((t) => t.trim()).filter((t) => t.length > 0)) {
      add(to);
      const key = [from, to].sort().join("~"); // undirected dedup
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key);
        edges.push({ from, to });
      }
    }
  }
  if (order.length > 12) throw new Error("Keep it to 12 nodes or fewer so the graph stays legible");
  return { nodes: order.map((id) => ({ id })), edges };
}
