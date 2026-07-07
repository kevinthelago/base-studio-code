// Network layout (#2505) — the pure (React-free) model behind NetworkPage. A general directed graph
// rides EXACTLY the shared graph stack the Tree layered variant established (treeLayout.ts, #2476):
// `findBackEdges` (#2217) breaks cycles so layering can't diverge, `layerDag` (#2214) assigns depths,
// `orderLayers` (#2418) runs the shared barycenter sweep (neighbors = every edge endpoint, both
// directions — the Glance discipline), and this module owns only the layer→pixel PLACEMENT
// (centered rows, top-down). Nothing here forks graph logic; it only feeds the shared pieces
// arbitrary node/edge input.
import { findBackEdges } from "@/shared/lib/graph/cycles";
import { layerDag } from "@/shared/lib/graph/layers";
import { orderLayers } from "@/shared/lib/graph/order";
import type { GraphEdge } from "@/shared/lib/graph/types";

/** One network node — the page renders label + optional meta on its card. */
export interface NetworkNodeData {
  id: string;
  label: string;
  /** Optional dimmed mono meta under the label (a kind, a count, a rate). */
  meta?: string;
}

/** One directed edge; `id` is derived (`from->to`) when omitted. */
export interface NetworkEdgeData {
  id?: string;
  from: string;
  to: string;
}

/** Node card box (world coords) — shared with NetworkPage's node + edge rendering. */
export const NET_NODE_W = 156;
export const NET_NODE_H = 46;

export interface NetworkLayoutMetrics {
  nodeW: number;
  nodeH: number;
  /** Horizontal clearance between nodes in a row. */
  hGap: number;
  /** Vertical clearance between layers (the gap the edges cross). */
  vGap: number;
  /** World padding around the whole layout. */
  pad: number;
}

export const DEFAULT_NET_METRICS: NetworkLayoutMetrics = {
  nodeW: NET_NODE_W, nodeH: NET_NODE_H, hGap: 30, vGap: 78, pad: 48,
};

export interface NetworkLayout {
  /** Node id → its card's top-left corner in world coords. */
  pos: Map<string, { x: number; y: number }>;
  /** Every edge (incl. cycle-closing ones — they still DRAW; they just don't layer). */
  edges: GraphEdge[];
  /** World (design-space) size — the GraphCanvas `world` box. */
  world: { w: number; h: number };
  /** Node id → its layer (0 = sources). Exposed for tests + callers. */
  layer: Record<string, number>;
}

/** Normalize the page's edges into the shared GraphEdge shape (derive missing ids). */
export function networkEdges(edges: readonly NetworkEdgeData[]): GraphEdge[] {
  return edges.map((e) => ({ id: e.id ?? `${e.from}->${e.to}`, from: e.from, to: e.to }));
}

/**
 * Top-down network placement: cycle-safe `layerDag` depth → row, shared barycenter ordering within
 * each row (neighbors = both endpoints of every edge), rows centered — the same discipline as
 * `layoutTree`, generalized to any directed graph.
 */
export function layoutNetwork(
  nodes: readonly NetworkNodeData[],
  edgeData: readonly NetworkEdgeData[],
  metrics: NetworkLayoutMetrics = DEFAULT_NET_METRICS,
): NetworkLayout {
  const m = metrics;
  const ids = nodes.map((n) => n.id);
  const edges = networkEdges(edgeData);
  const { backEdgeIds } = findBackEdges(ids, edges);
  const layer = layerDag(ids, edges, backEdgeIds);

  // Barycenter neighbors: every edge endpoint, in both directions (multiplicity counts).
  const neighbors = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) {
    if (e.from === e.to) continue;
    neighbors.get(e.from)?.push(e.to);
    neighbors.get(e.to)?.push(e.from);
  }
  const rows = orderLayers(ids, (id) => layer[id] ?? 0, (id) => neighbors.get(id) ?? []);

  const rowWidth = (n: number) => n * m.nodeW + Math.max(0, n - 1) * m.hGap;
  const maxRow = Math.max(0, ...[...rows.values()].map((r) => r.length));
  const w = Math.max(320, 2 * m.pad + rowWidth(maxRow));

  const pos = new Map<string, { x: number; y: number }>();
  let bottom = m.pad;
  for (const [l, row] of [...rows.entries()].sort(([a], [b]) => a - b)) {
    const y = m.pad + l * (m.nodeH + m.vGap);
    const x0 = (w - rowWidth(row.length)) / 2; // center each row — hubs sit toward the middle
    row.forEach((id, i) => pos.set(id, { x: x0 + i * (m.nodeW + m.hGap), y }));
    bottom = y + m.nodeH;
  }
  const h = Math.max(240, bottom + m.pad);

  return { pos, edges, world: { w, h }, layer };
}
