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
export const DEFAULT_GRAPH: GraphInput = {
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

/** Depth-first search from the first node — go deep along one path, backtracking when a node has no
 *  undiscovered neighbours. The visit order goes deep first (distinct from BFS's level-by-level order). */
export function dfs(g: TracedGraph): void {
  const ids = g.ids();
  if (ids.length === 0) return;
  const seen = new Set<string>([ids[0]]);
  const go = (node: string): void => {
    g.visit(node);
    for (const nb of g.neighbours(node)) {
      if (!seen.has(nb.to)) {
        seen.add(nb.to);
        g.relax(node, nb.to);
        g.frontier(nb.to);
        go(nb.to);
      }
    }
  };
  g.frontier(ids[0]);
  go(ids[0]);
}

/** A weighted graph for the shortest-path algorithms — the edge weights drive the visit ORDER. */
export const WEIGHTED_GRAPH: GraphInput = {
  nodes: ["a", "b", "c", "d", "e", "f"].map((id) => ({ id })),
  edges: [
    { from: "a", to: "b", weight: 4 },
    { from: "a", to: "c", weight: 2 },
    { from: "b", to: "c", weight: 1 },
    { from: "b", to: "d", weight: 5 },
    { from: "c", to: "d", weight: 8 },
    { from: "c", to: "e", weight: 10 },
    { from: "d", to: "e", weight: 2 },
    { from: "d", to: "f", weight: 6 },
    { from: "e", to: "f", weight: 3 },
  ],
};

/** Dijkstra's shortest path from the first node to the last — visit unvisited nodes in increasing
 *  distance (O(V²) min-extract, teaching-sized), relaxing edges to shorten neighbours, then light the
 *  final route. */
export function dijkstra(g: TracedGraph): void {
  const ids = g.ids();
  if (ids.length === 0) return;
  const start = ids[0];
  const goal = ids[ids.length - 1];
  const dist = new Map<string, number>(ids.map((id) => [id, Infinity]));
  const prev = new Map<string, string>();
  const done = new Set<string>();
  dist.set(start, 0);
  g.mark(start, "start");
  g.mark(goal, "goal");
  while (done.size < ids.length) {
    let u: string | null = null;
    let best = Infinity;
    for (const id of ids) {
      const d = dist.get(id) ?? Infinity;
      if (!done.has(id) && d < best) {
        best = d;
        u = id;
      }
    }
    if (u === null) break; // the remaining nodes are unreachable
    done.add(u);
    g.current(u);
    g.visit(u);
    for (const nb of g.neighbours(u)) {
      if (done.has(nb.to)) continue;
      g.relax(u, nb.to);
      const nd = (dist.get(u) ?? Infinity) + nb.weight;
      if (nd < (dist.get(nb.to) ?? Infinity)) {
        dist.set(nb.to, nd);
        prev.set(nb.to, u);
        g.frontier(nb.to);
      }
    }
  }
  if ((dist.get(goal) ?? Infinity) < Infinity) {
    const path: string[] = [];
    let cur: string | undefined = goal;
    while (cur !== undefined) {
      path.unshift(cur);
      cur = prev.get(cur);
    }
    g.path(path);
  }
}

/** A small DAG for topological sort — directed edges (`from → to`) with no cycle. */
const DAG_GRAPH: GraphInput = {
  nodes: ["a", "b", "c", "d", "e", "f"].map((id) => ({ id })),
  edges: [
    { from: "a", to: "c" },
    { from: "b", to: "c" },
    { from: "b", to: "d" },
    { from: "c", to: "e" },
    { from: "d", to: "e" },
    { from: "e", to: "f" },
  ],
};

/** Kahn's topological sort — repeatedly take a node with no remaining incoming edges (in-degree 0),
 *  visit it, and decrement its successors' in-degrees. The visit order is a valid topological order. */
export function topologicalSort(g: TracedGraph): void {
  const ids = g.ids();
  const indeg = g.inDegrees();
  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  const order: string[] = [];
  for (const id of queue) g.frontier(id);
  while (queue.length > 0) {
    const node = queue.shift() as string;
    g.visit(node);
    order.push(node);
    for (const nb of g.outNeighbours(node)) {
      g.relax(node, nb.to);
      const d = (indeg.get(nb.to) ?? 0) - 1;
      indeg.set(nb.to, d);
      if (d === 0) {
        g.frontier(nb.to);
        queue.push(nb.to);
      }
    }
  }
  if (order.length === ids.length) g.path(order); // a valid order exists (the DAG has no cycle)
}

/** A SPATIAL weighted graph (nodes carry x/y) — A*'s heuristic (straight-line distance to the goal) guides
 *  the search toward `g`, pruning the off-route nodes Dijkstra would still explore. Edge weights are the
 *  straight-line distances, so the heuristic is admissible. */
const SPATIAL_GRAPH: GraphInput = {
  nodes: [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 2, y: 0 },
    { id: "c", x: 1, y: 3 },
    { id: "d", x: 4, y: 0 },
    { id: "e", x: 4, y: 2 },
    { id: "g", x: 6, y: 0 },
  ],
  edges: [
    { from: "a", to: "b", weight: 2 },
    { from: "a", to: "c", weight: 3.2 },
    { from: "b", to: "d", weight: 2 },
    { from: "b", to: "e", weight: 2.8 },
    { from: "c", to: "e", weight: 3.2 },
    { from: "d", to: "e", weight: 2 },
    { from: "d", to: "g", weight: 2 },
    { from: "e", to: "g", weight: 2.8 },
  ],
};

/** Straight-line distance between two points; `0` when either lacks coordinates (A* → Dijkstra). */
function euclid(a: { x: number; y: number } | null, b: { x: number; y: number } | null): number {
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
}

/** A* shortest path from the first node to the last — like Dijkstra, but the priority is g + h where h is
 *  the straight-line distance to the goal, so the search is guided toward it (exploring fewer nodes). */
export function aStar(g: TracedGraph): void {
  const ids = g.ids();
  if (ids.length === 0) return;
  const start = ids[0];
  const goal = ids[ids.length - 1];
  const gScore = new Map<string, number>(ids.map((id) => [id, Infinity]));
  const fScore = new Map<string, number>(ids.map((id) => [id, Infinity]));
  const prev = new Map<string, string>();
  const open = new Set<string>([start]);
  const closed = new Set<string>();
  const h = (id: string): number => euclid(g.coord(id), g.coord(goal));
  gScore.set(start, 0);
  fScore.set(start, h(start));
  g.mark(start, "start");
  g.mark(goal, "goal");
  while (open.size > 0) {
    let cur: string | null = null;
    let best = Infinity;
    for (const id of open) {
      const f = fScore.get(id) ?? Infinity;
      if (f < best) {
        best = f;
        cur = id;
      }
    }
    if (cur === null) break;
    open.delete(cur);
    closed.add(cur);
    g.current(cur);
    g.visit(cur);
    if (cur === goal) break; // reached — the heuristic guarantees this is optimal
    for (const nb of g.neighbours(cur)) {
      if (closed.has(nb.to)) continue;
      g.relax(cur, nb.to);
      const tentative = (gScore.get(cur) ?? Infinity) + nb.weight;
      if (tentative < (gScore.get(nb.to) ?? Infinity)) {
        prev.set(nb.to, cur);
        gScore.set(nb.to, tentative);
        fScore.set(nb.to, tentative + h(nb.to));
        open.add(nb.to);
        g.frontier(nb.to);
      }
    }
  }
  if (goal === start || prev.has(goal)) {
    const path: string[] = [];
    let c: string | undefined = goal;
    while (c !== undefined) {
      path.unshift(c);
      c = prev.get(c);
    }
    g.path(path);
  }
}

/** The visualizable graph algorithms, keyed by base name (#3224/#3226/#3228) — the full family. */
export const GRAPH_PROGRAMS: Record<string, GraphProgram> = {
  bfs: { run: bfs, defaultInput: DEFAULT_GRAPH },
  dfs: { run: dfs, defaultInput: DEFAULT_GRAPH },
  dijkstra: { run: dijkstra, defaultInput: WEIGHTED_GRAPH },
  "a-star": { run: aStar, defaultInput: SPATIAL_GRAPH },
  "topological-sort": { run: topologicalSort, defaultInput: DAG_GRAPH },
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
