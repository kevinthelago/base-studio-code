// Barycenter layer ordering (#2418, graph-core epic #2214) — the ONE crossing-reduction sweep the
// layered graphs share. Given a layer assignment (from `layerDag` or any layerer), order the nodes
// WITHIN each layer so each sits near the mean in-layer index of its neighbors — the classic Sugiyama
// barycenter heuristic. What VARIES per graph is tunable: the neighbor gathering (org pulls only from
// cross-layer hierarchy parents/children; Glance from every edge endpoint), the pass count, and the
// sweep discipline. Pure; the caller owns the layer→pixel placement.

export interface OrderLayersOpts {
  /** Barycenter sweeps over the whole layer set. Default 4. */
  passes?: number;
  /** How fresh the neighbor indexes are within one pass:
   *   • "sequential" (default) — sorting layer L reads the ALREADY re-sorted order of the layers
   *     sorted earlier in the same pass, so an improvement propagates immediately (org's discipline).
   *   • "snapshot" — every layer sorts against the order at the START of the pass (Glance's). */
  sweep?: "sequential" | "snapshot";
}

/**
 * Order the nodes within each layer by the barycenter heuristic: each layer is sorted by the mean
 * in-layer index of each node's neighbors; a node with no (known) neighbors keeps its current index.
 * The initial order is `nodeIds` order filtered per layer; ties keep the pre-sort order (stable sort).
 *
 * @param nodeIds Every node, in the initial (seed) order.
 * @param layerOf The layer assignment (e.g. `layerDag`'s).
 * @param neighborsOf The ids whose in-layer positions pull on a node — the caller's neighbor
 *   gathering. Multiplicity counts (a doubly-connected neighbor pulls twice); ids outside `nodeIds`
 *   are ignored.
 * @returns layer → its node ids in final order (layers in ascending order).
 */
export function orderLayers(
  nodeIds: readonly string[],
  layerOf: (id: string) => number,
  neighborsOf: (id: string) => readonly string[],
  opts: OrderLayersOpts = {},
): Map<number, string[]> {
  const passes = opts.passes ?? 4;
  const sweep = opts.sweep ?? "sequential";
  const layers = [...new Set(nodeIds.map(layerOf))].sort((a, b) => a - b);
  const order = new Map<number, string[]>(layers.map((l) => [l, nodeIds.filter((n) => layerOf(n) === l)]));
  const idx = new Map<string, number>();
  const reindex = (l: number) => order.get(l)!.forEach((n, i) => idx.set(n, i));
  layers.forEach(reindex);

  const bary = (n: string): number => {
    const neigh = neighborsOf(n).filter((m) => idx.has(m));
    if (neigh.length === 0) return idx.get(n)!;
    return neigh.reduce((s, m) => s + idx.get(m)!, 0) / neigh.length;
  };
  const sortLayer = (l: number, b: Map<string, number>) => {
    order.get(l)!.sort((x, y) => b.get(x)! - b.get(y)!);
    reindex(l);
  };

  for (let pass = 0; pass < passes; pass++) {
    if (sweep === "snapshot") {
      const b = new Map(nodeIds.map((n) => [n, bary(n)] as const));
      for (const l of layers) sortLayer(l, b);
    } else {
      for (const l of layers) sortLayer(l, new Map(order.get(l)!.map((n) => [n, bary(n)] as const)));
    }
  }
  return order;
}
