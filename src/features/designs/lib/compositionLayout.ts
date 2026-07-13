// Composition-graph layout (#2455, #2964, #2970) — the pure, hierarchical TOP-DOWN placement for the
// Design Studio's composition graph, banded into four SEMANTIC ROLE TIERS and labeled as swimlanes:
//
//   • PAGES (top)         — complete ideas / whole screens (`role === "page"`).
//   • LAYOUTS             — structural POSITIONERS: arrange children, render no content of their own
//                           (`role === "layout"` — Box, Stack, Grid, MasterDetail, …). The maintainer's
//                           flexbox framing — the scaffold the content sits in — so they rank just under
//                           Pages, ABOVE the composables that fill them (#2970).
//   • COMPOSABLES         — assembled widgets (`role` composite / service — Card, Dialog, StatCard, …).
//   • FUNDAMENTALS (base) — content atoms (`role === "primitive"` — Button, Text, Chip, …).
//
// Purely ROLE-DRIVEN (#2970): the tier is the component's kind, so a composition ROOT nobody uses yet
// (an unwired composite like `ItemBars`) no longer floats up into the page band — it sits in Composables
// where it belongs. Composition (`composes`) is the EDGE set + still drawn, but no longer the y-axis.
// One band per present tier, ordered within by importance (`used` desc, name tiebreak), wrapping into
// sub-rows past `maxPerRow`. The `lanes` tile the world height so the chrome can label each tier.
//
// Pure and React-free; DesignsWorkbench's graph memo is a single call to `layoutComposition`.
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

/** A semantic vertical tier (#2964/#2970), top → bottom: complete ideas (`page`), structural positioners
 *  (`layout`), assembled widgets (`composable`), content atoms (`fundamental`). */
export type Tier = "page" | "layout" | "composable" | "fundamental";

/** Tier order, top → bottom. */
export const TIER_ORDER: readonly Tier[] = ["page", "layout", "composable", "fundamental"];

/** The lane label shown for each tier. */
export const LANE_LABEL: Record<Tier, string> = {
  page: "Pages",
  layout: "Layouts",
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
  /** Node id → its semantic tier (#2964/#2970). */
  tier: Map<string, Tier>;
  /** The swimlanes, top → bottom — one per PRESENT tier, tiled to fill the world height. */
  lanes: CompositionLane[];
}

/**
 * The semantic tier a component belongs to (#2970) — purely by its architectural `role`:
 * `page` → Pages, `layout` → Layouts (a structural positioner), `primitive` → Fundamentals (a content
 * atom), everything else (`composite`, `service`) → Composables (an assembled widget).
 */
export function nodeTier(role: Role): Tier {
  if (role === "page") return "page";
  if (role === "layout") return "layout";
  if (role === "primitive") return "fundamental";
  return "composable";
}

/** Sort components by graph TIER (Pages → Layouts → Composables → Fundamentals), then importance
 *  (`used` desc, name tiebreak). The rail (#2976) sorts its list with this so it reads like the graph. */
export const byTier = (a: ComponentRecord, b: ComponentRecord): number =>
  TIER_ORDER.indexOf(nodeTier(a.role)) - TIER_ORDER.indexOf(nodeTier(b.role)) ||
  b.used - a.used ||
  a.name.localeCompare(b.name);

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
 * One band per PRESENT tier, in `TIER_ORDER` (an absent tier leaves no gap). Each band is ordered by
 * importance and wraps into sub-rows past `maxPerRow`. The `lanes` tile the world height so the chrome
 * can label each tier.
 */
export function layoutComposition(
  comps: readonly ComponentRecord[],
  metrics: CompositionLayoutMetrics = DEFAULT_METRICS,
): CompositionLayout {
  const m = metrics;
  const edges = buildComposesEdges(comps);

  const tier = new Map<string, Tier>();
  for (const c of comps) tier.set(c.id, nodeTier(c.role));

  // One band per PRESENT tier, top → bottom in TIER_ORDER.
  const present = TIER_ORDER.filter((t) => comps.some((c) => tier.get(c.id) === t));
  const bandOfTier = new Map<Tier, number>(present.map((t, i) => [t, i]));
  const depth = new Map<string, number>();
  for (const c of comps) depth.set(c.id, bandOfTier.get(tier.get(c.id)!)!);

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
