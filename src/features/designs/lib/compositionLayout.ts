// Composition-graph layout (#2455, #2964) — the pure, hierarchical TOP-DOWN placement for the Design
// Studio's composition graph, banded into three SEMANTIC TIERS and labeled as swimlanes:
//
//   • PAGES (top)         — complete ideas (`role === "page"`).
//   • COMPOSABLES (middle)— things that ASSEMBLE other components; sub-layered by composition depth
//                           (via the shared `layerDag`, #2214) so a composable that composes another
//                           sits above it.
//   • FUNDAMENTALS (base) — building blocks: a `primitive`, or ANY leaf that composes nothing in-kit
//                           (e.g. `Card`, a leaf `layout`). One band, at the bottom.
//
// This replaced the old rule (pure composition depth + a role-tier fallback for isolated nodes, #2455),
// which conflated composition ROOTS (in-degree 0) — so an unused composable like `ItemBars` landed in the
// top band shoulder-to-shoulder with the pages. Tier-anchoring keeps pages alone at the top and every
// leaf at the base, whatever their composition depth.
//
// Two kit-specific rules live here (which is why this is feature lib, not shared graph):
//   • TIER ANCHORING — pages own the top band, fundamentals the base band; composables fill the middle.
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

/** A semantic vertical tier (#2964): complete ideas (`page`) at the top, fundamental building blocks
 *  (`primitive` or a leaf) at the base, everything that assembles others (`composable`) between. */
export type Tier = "page" | "composable" | "fundamental";

/** Tier order, top → bottom. */
export const TIER_ORDER: readonly Tier[] = ["page", "composable", "fundamental"];

/** The lane label shown for each tier. */
export const LANE_LABEL: Record<Tier, string> = {
  page: "Pages",
  composable: "Composables",
  fundamental: "Fundamentals",
};

/** One horizontal swimlane — a tier's full-width vertical extent in world coords (tiled to fill). */
export interface CompositionLane {
  tier: Tier;
  label: string;
  y0: number;
  y1: number;
}

export interface CompositionLayout {
  pos: Map<string, { x: number; y: number }>;
  edges: GraphEdge[];
  world: { w: number; h: number };
  /** Node id → its vertical band (0 = top row). Exposed for tests + the lane chrome. */
  depth: Map<string, number>;
  /** Node id → its semantic tier (#2964). */
  tier: Map<string, Tier>;
  /** The swimlanes, top → bottom — one per PRESENT tier, tiled to fill the world height. */
  lanes: CompositionLane[];
}

/**
 * The semantic tier a component belongs to (#2964).
 *
 * A `page` is a complete idea (top). A `primitive`, or ANY leaf that composes nothing in-kit
 * (`outDeg === 0` — e.g. `Card`, a leaf `layout`), is a fundamental building block (base). Everything
 * that assembles other components is a composable (middle); `service` groups with composables. `outDeg`
 * is the node's RESOLVED out-degree (its in-kit `composes` edges).
 */
export function nodeTier(role: Role, outDeg: number): Tier {
  if (role === "page") return "page";
  if (role === "primitive" || outDeg === 0) return "fundamental";
  return "composable";
}

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
 * Compute the tier-banded, top-down composition layout for one kit's components.
 *
 * Bands, top → bottom: the PAGE band (all pages), then one sub-band per distinct composition depth
 * among the composables (so a composable that composes another sits above it), then the FUNDAMENTAL
 * band (all leaves/primitives). Only PRESENT tiers take a row, so an absent tier leaves no gap. Each
 * band is ordered by importance and wraps into sub-rows past `maxPerRow`. The `lanes` tile the world
 * height so the chrome can label each tier.
 */
export function layoutComposition(
  comps: readonly ComponentRecord[],
  metrics: CompositionLayoutMetrics = DEFAULT_METRICS,
): CompositionLayout {
  const m = metrics;
  const edges = buildComposesEdges(comps);
  const outDeg = new Map<string, number>();
  for (const e of edges) outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);

  // Composition longest-path depth — orders composables among themselves (a composer above its dep).
  const layer = layerDag(comps.map((c) => c.id), edges);

  // Tier each node, then band tier-anchored: pages own the TOP band, fundamentals the BASE band, and
  // composables fill sub-bands BETWEEN them ordered by composition depth. Only PRESENT bands take a row.
  const tier = new Map<string, Tier>();
  for (const c of comps) tier.set(c.id, nodeTier(c.role, outDeg.get(c.id) ?? 0));

  const composableLayers = [
    ...new Set(comps.filter((c) => tier.get(c.id) === "composable").map((c) => layer[c.id] ?? 0)),
  ].sort((a, b) => a - b);
  const subBand = new Map<number, number>(); // composition layer → composable sub-band offset
  composableLayers.forEach((l, i) => subBand.set(l, i));

  const hasPage = comps.some((c) => tier.get(c.id) === "page");
  const composableBase = hasPage ? 1 : 0;
  const fundBand = composableBase + composableLayers.length;

  const depth = new Map<string, number>();
  for (const c of comps) {
    const t = tier.get(c.id)!;
    depth.set(
      c.id,
      t === "page" ? 0 : t === "fundamental" ? fundBand : composableBase + (subBand.get(layer[c.id] ?? 0) ?? 0),
    );
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

  // Swimlanes: each present tier's vertical extent, tiled to fill the world height (a boundary falls at
  // the midpoint of the gap between adjacent tiers; the top lane starts at 0, the bottom ends at `h`).
  const tierYs = new Map<Tier, { min: number; max: number }>();
  for (const c of comps) {
    const p = pos.get(c.id)!;
    const t = tier.get(c.id)!;
    const cur = tierYs.get(t);
    if (cur) { cur.min = Math.min(cur.min, p.y); cur.max = Math.max(cur.max, p.y + m.nodeH); }
    else tierYs.set(t, { min: p.y, max: p.y + m.nodeH });
  }
  const present = TIER_ORDER.filter((t) => tierYs.has(t));
  const lanes: CompositionLane[] = present.map((t, i) => ({
    tier: t,
    label: LANE_LABEL[t],
    y0: i === 0 ? 0 : (tierYs.get(present[i - 1])!.max + tierYs.get(t)!.min) / 2,
    y1: i === present.length - 1 ? h : (tierYs.get(t)!.max + tierYs.get(present[i + 1])!.min) / 2,
  }));

  return { pos, edges, world: { w, h }, depth, tier, lanes };
}

// `selectionNeighborhood` (#2523) was promoted to a shared graph util (#2719) — it's a pure,
// layout-agnostic edge/node query, not composition-specific. Re-exported here so the existing
// intra-feature importers (DesignsWorkbench, this feature's tests) don't churn.
export { selectionNeighborhood, type SelectionNeighborhood } from "@/shared/lib/graph/selectionNeighborhood";
