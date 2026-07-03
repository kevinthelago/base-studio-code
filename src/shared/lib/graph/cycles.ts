// Cycle detection (#2217, graph-core epic #2214) — the shared primitives the graphs use to find cycles
// in a directed graph. Two flavours, matching what the features already do:
//   • findBackEdges — DFS (white/grey/black) back-edge detection: finds ANY-length cycle and returns
//     the edges that close one. Used for topological layering (exclude back-edges so a cycle can't
//     explode the layout) and to flag coordination deadlocks. This is the relationship graph's algorithm.
//   • mutualPairs — the 2-cycle special case (a↔b): the cheap "mutual dependency" check the Glance
//     network surfaces as coordination hazards.
// Both are pure; the caller pre-filters to whichever edge subset is order-bearing.
import type { GraphEdge } from "./types";

/**
 * DFS back-edge detection over `edges` restricted to `nodeIds`. Returns the set of edge ids that close
 * a cycle (grey-target back-edges) and whether any cycle exists. Nodes are visited in `nodeIds` order
 * and each node's out-edges in `edges` order, so the result is deterministic.
 */
export function findBackEdges(nodeIds: readonly string[], edges: readonly GraphEdge[]): { backEdgeIds: Set<string>; hasCycle: boolean } {
  const idSet = new Set(nodeIds);
  const adj = new Map<string, { to: string; id: string }[]>(nodeIds.map((i) => [i, []]));
  for (const e of edges) {
    if (idSet.has(e.from) && idSet.has(e.to)) adj.get(e.from)!.push({ to: e.to, id: e.id });
  }
  const color = new Map<string, 0 | 1 | 2>(); // 0 white · 1 grey (on stack) · 2 black
  const backEdgeIds = new Set<string>();
  let hasCycle = false;
  const dfs = (n: string) => {
    color.set(n, 1);
    for (const { to, id } of adj.get(n) ?? []) {
      const c = color.get(to) ?? 0;
      if (c === 1) { hasCycle = true; backEdgeIds.add(id); } // back-edge → a cycle
      else if (c === 0) dfs(to);
    }
    color.set(n, 2);
  };
  for (const i of nodeIds) if ((color.get(i) ?? 0) === 0) dfs(i);
  return { backEdgeIds, hasCycle };
}

/**
 * Mutual pairs (a↔b) — every pair of nodes with edges in both directions. Returns the pairs (each once,
 * `from < to`), the ids of ALL edges in a mutual pair (both directions), and the node ids involved.
 */
export function mutualPairs(edges: readonly GraphEdge[]): { pairs: [string, string][]; edgeIds: Set<string>; nodeIds: Set<string> } {
  const pairs: [string, string][] = [];
  const edgeIds = new Set<string>();
  const nodeIds = new Set<string>();
  for (const a of edges) for (const b of edges) {
    if (a.from === b.to && a.to === b.from && a.from < a.to) {
      edgeIds.add(a.id); edgeIds.add(b.id);
      pairs.push([a.from, a.to]);
      nodeIds.add(a.from); nodeIds.add(a.to);
    }
  }
  return { pairs, edgeIds, nodeIds };
}
