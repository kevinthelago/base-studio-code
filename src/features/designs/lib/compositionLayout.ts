// Composition-graph layout (#2455) — the pure, hierarchical TOP-DOWN placement for the Design
// Studio's composition graph. Layers come from the shared `layerDag` (#2214) over the kit's
// `composes` edges and are placed as ROWS: composers above, dependencies below — pages/layout
// shells at the top, primitives at the bottom.
//
// Two component-kit-specific rules live here (which is why this is feature lib, not shared graph):
//   • ROLE-TIER FALLBACK — a node with NO composes edges in either direction is banded by its
//     architectural role instead of dumping into layer 0: page → layout → composite (service
//     alongside) → primitive, mapped onto a representative DAG depth so isolated nodes sit INLINE
//     in their tier's row(s) rather than on a separate shelf.
//   • IMPORTANCE ORDERING — within a row, nodes sort by the `used` count (the cross-codebase reuse
//     signal) descending, name as the stable tiebreak. Ordering only; no size/emphasis scaling.
//
// Pure and React-free; DesignsWorkbench's graph memo is a single call to `layoutComposition`.
import { layerDag } from "@/shared/lib/graph/layers";
import type { GraphEdge } from "@/shared/lib/graph/types";
import type { ComponentRecord, Role } from "./model";

/** Graph node box (world coords) — shared with the GraphView's node + edge rendering. */
export const NODE_W = 170;
export const NODE_H = 54;

export interface CompositionLayoutMetrics {
  nodeW: number;
  nodeH: number;
  /** Horizontal clearance between nodes in a row. */
  hGap: number;
  /** Vertical clearance between depth bands (the hierarchy gap the edges cross). */
  bandGap: number;
  /** Vertical clearance between wrapped sub-rows inside one band. */
  subRowGap: number;
  /** World padding around the whole layout. */
  pad: number;
  /** A band wraps onto a new sub-row after this many nodes. */
  maxPerRow: number;
}

export const DEFAULT_METRICS: CompositionLayoutMetrics = {
  nodeW: NODE_W, nodeH: NODE_H, hGap: 28, bandGap: 92, subRowGap: 26, pad: 60, maxPerRow: 8,
};

export interface CompositionLayout {
  pos: Map<string, { x: number; y: number }>;
  edges: GraphEdge[];
  world: { w: number; h: number };
  /** Node id → its vertical band (0 = top row). Exposed for tests + future band chrome. */
  depth: Map<string, number>;
}

/** Role → tier rank, top (0) to bottom (3). `service` bands alongside `composite`. */
export const TIER_INDEX: Record<Role, number> = {
  page: 0, layout: 1, composite: 2, service: 2, primitive: 3,
};
const TIER_COUNT = 4;

/** The kit's `composes` names resolved to in-kit edges (composer → dependency). Names that don't
 *  resolve to a component in `comps` are dropped — no dangling graph edges. */
export function buildComposesEdges(comps: readonly ComponentRecord[]): GraphEdge[] {
  const idByName = new Map(comps.map((c) => [c.name, c.id] as const));
  const edges: GraphEdge[] = [];
  for (const c of comps) {
    for (const dep of c.composes) {
      const to = idByName.get(dep);
      if (to) edges.push({ id: `${c.id}->${to}`, from: c.id, to });
    }
  }
  return edges;
}

/** Within-row importance order: `used` descending, stable name tiebreak. */
const byImportance = (a: ComponentRecord, b: ComponentRecord): number =>
  b.used - a.used || a.name.localeCompare(b.name);

/**
 * Compute the top-down composition layout for one kit's components.
 *
 * Depth assignment: connected nodes (any composes edge in either direction) keep their `layerDag`
 * depth — a composer always sits strictly above its dependencies. Isolated nodes map their role
 * tier onto a representative connected depth (`floor(tier · (maxDepth+1) / 4)`, clamped), so e.g.
 * with a 3-deep DAG the isolated layout shells join the top band, isolated composites the middle,
 * isolated primitives the bottom. With no edges at all the tiers themselves become the rows.
 */
export function layoutComposition(
  comps: readonly ComponentRecord[],
  metrics: CompositionLayoutMetrics = DEFAULT_METRICS,
): CompositionLayout {
  const m = metrics;
  const edges = buildComposesEdges(comps);
  const connected = new Set<string>();
  for (const e of edges) { connected.add(e.from); connected.add(e.to); }

  const layer = layerDag(comps.map((c) => c.id), edges);
  let maxDepth = 0;
  for (const id of connected) maxDepth = Math.max(maxDepth, layer[id] ?? 0);

  const depth = new Map<string, number>();
  for (const c of comps) {
    if (connected.has(c.id)) { depth.set(c.id, layer[c.id] ?? 0); continue; }
    const tier = TIER_INDEX[c.role];
    depth.set(c.id, connected.size === 0
      ? tier
      : Math.min(maxDepth, Math.floor((tier * (maxDepth + 1)) / TIER_COUNT)));
  }

  // Band the nodes by depth, order each band by importance, wrap into sub-rows.
  const bands = new Map<number, ComponentRecord[]>();
  for (const c of comps) {
    const d = depth.get(c.id)!;
    const band = bands.get(d);
    if (band) band.push(c); else bands.set(d, [c]);
  }
  const bandRows: ComponentRecord[][][] = [...bands.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, band]) => {
      const sorted = band.sort(byImportance);
      const rows: ComponentRecord[][] = [];
      for (let i = 0; i < sorted.length; i += m.maxPerRow) rows.push(sorted.slice(i, i + m.maxPerRow));
      return rows;
    });

  const rowWidth = (n: number) => n * m.nodeW + (n - 1) * m.hGap;
  const maxRow = Math.max(0, ...bandRows.flat().map((r) => r.length));
  const w = Math.max(400, 2 * m.pad + rowWidth(maxRow));

  const pos = new Map<string, { x: number; y: number }>();
  let y = m.pad;
  let bottom = m.pad;
  for (let bi = 0; bi < bandRows.length; bi++) {
    const rows = bandRows[bi];
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
      const x0 = (w - rowWidth(row.length)) / 2;   // center each row — hubs sit toward the middle
      row.forEach((c, i) => pos.set(c.id, { x: x0 + i * (m.nodeW + m.hGap), y }));
      bottom = y + m.nodeH;
      y += m.nodeH + (ri < rows.length - 1 ? m.subRowGap : m.bandGap);
    }
  }
  const h = Math.max(300, bottom + m.pad);

  return { pos, edges, world: { w, h }, depth };
}

// `selectionNeighborhood` (#2523) was promoted to a shared graph util (#2719) — it's a pure,
// layout-agnostic edge/node query, not composition-specific. Re-exported here so the existing
// intra-feature importers (DesignsWorkbench, this feature's tests) don't churn.
export { selectionNeighborhood, type SelectionNeighborhood } from "@/shared/lib/graph/selectionNeighborhood";
