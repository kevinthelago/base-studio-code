// Topological layering (#2214, graph-core epic) — the ONE longest-path layerer the graphs share. A
// dependency/coordination DAG flows across LAYERS: each node lands as deep as its longest incoming
// chain, so a source (no in-edges) sits at layer 0. The caller hands in a cycle-break set (the
// back-edges it already computed via `cycles.ts`, or its 2-cycle mutual pairs) so a loop can't diverge
// the layout. Pure; the callers own the layer→pixel PLACEMENT (Glance's grid, Relationship's swimlanes)
// — this only assigns the layer number.
import type { GraphEdge } from "./types";

/**
 * Longest-path topological layering. Assigns each node in `nodeIds` an integer layer so that for every
 * kept edge `from→to`, `layer[to] >= layer[from] + 1` — sources sit at layer 0 and each node lands as
 * deep as its longest incoming chain. Edges in `backEdgeIds` (the caller's cycle-break set), self-loops,
 * and edges touching an id outside `nodeIds` are ignored, so a cycle can't diverge the assignment. The
 * result is the DAG's unique longest-path layering, so it's independent of the relaxation order (and
 * identical to a Kahn / memoized-DFS layerer over the same acyclic edge set).
 *
 * Edge direction is "from → deeper": a node points to the nodes that must sit BELOW it. A "depends-on"
 * DAG — where the dependency should sit at a LOWER layer than its dependent — reverses its edges before
 * calling (see Glance's `buildGraph`).
 */
export function layerDag(
  nodeIds: readonly string[],
  edges: readonly GraphEdge[],
  backEdgeIds?: ReadonlySet<string>,
): Record<string, number> {
  const idSet = new Set(nodeIds);
  const kept = edges.filter(
    (e) => e.from !== e.to && idSet.has(e.from) && idSet.has(e.to) && !backEdgeIds?.has(e.id),
  );
  const layer: Record<string, number> = {};
  for (const id of nodeIds) layer[id] = 0;
  // Relax to the fixpoint: the longest path on a DAG spans ≤ nodeIds.length edges, so that many sweeps
  // always converge; the `changed` guard usually breaks far sooner. Same result as Kahn — order-free.
  for (let iter = 0; iter <= nodeIds.length; iter++) {
    let changed = false;
    for (const e of kept) {
      if (layer[e.to] < layer[e.from] + 1) { layer[e.to] = layer[e.from] + 1; changed = true; }
    }
    if (!changed) break;
  }
  return layer;
}
