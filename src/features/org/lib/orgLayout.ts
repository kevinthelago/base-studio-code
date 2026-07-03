// Org canvas geometry (#2193) — pure math for the relationship graph, ported from the Claude Design
// prototype. Kept React-free so it's unit-testable and the canvas component stays a thin renderer.
// The graph lives in a fixed 1120×800 design space; the canvas scales it by a zoom factor.
import { forceSimulation, forceLink, forceManyBody, forceX, forceCollide, type SimulationNodeDatum } from "d3-force";
import { graphEdge } from "@/shared/lib/graph/edgePath";
import type { Org, Position, PositionKind } from "./org";

/** The fixed design coordinate space every node's x/y is authored in. */
export const CANVAS_W = 1120;
export const CANVAS_H = 800;

/** Node box size per kind (design-space px) — person cards are the largest; resource/external smaller. */
export const NODE_SIZE: Record<PositionKind, { w: number; h: number }> = {
  agent: { w: 190, h: 96 },
  resource: { w: 156, h: 82 },
  external: { w: 152, h: 80 },
};

export interface Box { x: number; y: number; w: number; h: number }

/** The design-space box for a position (its authored x/y + the size for its kind; 0,0 if unplaced). */
export function nodeBox(pos: Position): Box {
  const { w, h } = NODE_SIZE[pos.kind];
  return { x: pos.x ?? 0, y: pos.y ?? 0, w, h };
}

/** The point on box `a`'s perimeter along the ray toward (tx,ty) — where an edge should meet the card.
 *  A 3px outset keeps the line clear of the border. Ported from the design's `_anchor`. */
export function anchor(a: Box, tx: number, ty: number): [number, number] {
  const cx = a.x + a.w / 2, cy = a.y + a.h / 2, dx = tx - cx, dy = ty - cy;
  const hw = a.w / 2 + 3, hh = a.h / 2 + 3;
  const sx = dx === 0 ? 1e9 : hw / Math.abs(dx);
  const sy = dy === 0 ? 1e9 : hh / Math.abs(dy);
  const s = Math.min(sx, sy);
  return [cx + dx * s, cy + dy * s];
}

export interface EdgeGeometry {
  /** SVG cubic-bezier path `d`. */
  d: string;
  /** The midpoint where the edge label pill sits. */
  lx: number;
  ly: number;
}

/** The bezier path + label point between two boxes, bowed by `bow` px off the straight line so parallel
 *  edges fan apart. The end is pulled back 9px to leave room for the arrowhead. Ported from `_geom`. */
export function edgeGeometry(A: Box, B: Box, bow = 0): EdgeGeometry {
  // The shared graph line-type (#2222); Org keeps its own arrowhead markers, so it only takes the
  // curve + the label midpoint. Byte-identical to the previous inline geometry.
  const { d, labelX, labelY } = graphEdge(A, B, { bow });
  return { d, lx: labelX, ly: labelY };
}

/** SVG dash-array for an archetype line style. */
export function styleDash(style: string): string {
  switch (style) {
    case "dashed": return "7 5";
    case "gated": return "3 5";
    case "dotted": return "1 6";
    case "resource": return "4 6";
    default: return "0"; // solid
  }
}

/** Clamp `z` to the canvas zoom range. */
export function clampZoom(z: number, min = 0.4, max = 1.5): number {
  return Math.max(min, Math.min(max, z));
}

// ── Auto-organize ────────────────────────────────────────────────────────────
/** Archetypes that impose a top-down hierarchy (a parent → child flow); peers/consults are lateral and
 *  don't drive layering. */
const HIERARCHY_ARCHETYPES = new Set(["manages", "serves", "oversees", "stewards"]);

const AUTO_COL = 230; // seed horizontal spacing between nodes in a layer (before force refinement)
const AUTO_ROW = 200; // vertical gap between hierarchy layers (fixed once assigned — keeps rows clean)

// Force-refinement tuning (fixed; the user never tunes these — #2199 follow-up). y is pinned per layer,
// so the simulation only moves nodes HORIZONTALLY: repulsion spreads a crowded row, link springs pull
// related nodes together, and a weak x-centering keeps the whole graph framed.
const LINK_DIST = 210;   // preferred edge length (a spring rest length)
const LINK_STR = 0.35;   // how hard edges pull (0–1) — gentle, so repulsion can still spread siblings
const CHARGE = -1600;    // many-body repulsion (negative = push apart) — the readability "breathing room"
const X_STR = 0.08;      // weak pull toward the horizontal center (keeps rows from drifting off-canvas)
const COLLIDE_PAD = 16;  // extra gap enforced around each card so nothing visually overlaps
const TICKS = 320;       // headless ticks to convergence (d3-force's seeded LCG makes this deterministic)
// These are tuned so a typical fleet settles well inside the 1120×800 design space (the default fleet
// lands at ~978×536) — no user knobs by design (#2199 follow-up); the graph just finds its own shape.

interface LayerResult { layer: Map<string, number>; order: Map<number, string[]> }

/** Assign each node a hierarchy layer (longest path from a root, cycle-guarded) and a crossing-reduced
 *  order within its layer (barycenter passes). The shared skeleton both the seed placement and the
 *  fixed-y force refinement build on. */
function layerNodes(org: Org): LayerResult {
  const ids = org.positions.map((p) => p.nodeId);
  const parents = new Map<string, string[]>(ids.map((n) => [n, []]));
  const children = new Map<string, string[]>(ids.map((n) => [n, []]));
  for (const r of org.relationships) {
    if (!HIERARCHY_ARCHETYPES.has(r.archetype)) continue;
    if (!parents.has(r.to) || !children.has(r.from)) continue;
    parents.get(r.to)!.push(r.from);
    children.get(r.from)!.push(r.to);
  }

  // Longest-path layering (roots at 0), with a cycle guard.
  const layer = new Map<string, number>();
  const active = new Set<string>();
  const calc = (n: string): number => {
    const cached = layer.get(n);
    if (cached !== undefined) return cached;
    if (active.has(n)) return 0; // cycle — break it
    active.add(n);
    const ps = parents.get(n)!;
    const l = ps.length === 0 ? 0 : Math.max(...ps.map(calc)) + 1;
    active.delete(n);
    layer.set(n, l);
    return l;
  };
  ids.forEach(calc);

  const layers = [...new Set(ids.map((n) => layer.get(n)!))].sort((a, b) => a - b);
  const order = new Map<number, string[]>(layers.map((l) => [l, ids.filter((n) => layer.get(n) === l)]));
  const indexIn = (l: number, n: string) => order.get(l)!.indexOf(n);
  const bary = (n: string): number => {
    const l = layer.get(n)!;
    const neigh = [...parents.get(n)!, ...children.get(n)!].filter((m) => layer.get(m) !== l);
    if (neigh.length === 0) return indexIn(l, n);
    return neigh.reduce((s, m) => s + indexIn(layer.get(m)!, m), 0) / neigh.length;
  };
  // Barycenter crossing reduction: order each node by the mean index of its neighbors in other layers.
  for (let pass = 0; pass < 4; pass++) for (const l of layers) order.get(l)!.sort((a, b) => bary(a) - bary(b));

  return { layer, order };
}

interface SimNode extends SimulationNodeDatum { id: string; w: number; h: number }

/** A deterministic hierarchical FORCE layout (#2199): every node is pinned to its hierarchy row (so the
 *  manager-above-reports structure stays razor-clean and same-layer nodes share an exact y), then a
 *  d3-force pass moves nodes only HORIZONTALLY — many-body repulsion gives each node breathing room,
 *  link springs pull related nodes together, and a weak centering keeps the graph framed. The result is
 *  the "natural structure" the graph finds on its own, so the user never has to hand-place a node.
 *
 *  Deterministic: d3-force seeds a fixed LCG (not `Math.random`) and the seed positions are computed, so
 *  re-running "Auto organize" reproduces the same layout. Returns fresh top-left `{x,y}` per nodeId. */
export function autoLayout(org: Org): Record<string, { x: number; y: number }> {
  const { layer, order } = layerNodes(org);
  const rowY = (l: number) => 60 + l * AUTO_ROW;

  // Seed each node at its row (center coords), spread horizontally by its in-layer order so the force
  // pass starts from a sane, crossing-reduced arrangement rather than a random cloud.
  const nodes: SimNode[] = org.positions.map((p) => {
    const l = layer.get(p.nodeId)!;
    const row = order.get(l)!;
    const idx = row.indexOf(p.nodeId);
    const { w, h } = NODE_SIZE[p.kind];
    return {
      id: p.nodeId,
      w, h,
      x: CANVAS_W / 2 + (idx - (row.length - 1) / 2) * AUTO_COL,
      y: rowY(l),
      fy: rowY(l), // pin y to the layer row — the simulation only optimizes x
    };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const links = org.relationships
    .filter((r) => byId.has(r.from) && byId.has(r.to))
    .map((r) => ({ source: r.from, target: r.to }));

  const sim = forceSimulation<SimNode>(nodes)
    .force("link", forceLink<SimNode, { source: string; target: string }>(links).id((d) => d.id).distance(LINK_DIST).strength(LINK_STR))
    .force("charge", forceManyBody<SimNode>().strength(CHARGE))
    .force("x", forceX<SimNode>(CANVAS_W / 2).strength(X_STR))
    .force("collide", forceCollide<SimNode>((d) => Math.max(d.w, d.h) / 2 + COLLIDE_PAD))
    .stop();
  for (let i = 0; i < TICKS; i++) sim.tick();

  // Convert sim centers → top-left boxes, then shift the whole graph into a padded positive space.
  const boxes = nodes.map((n) => ({ id: n.id, x: (n.x ?? 0) - n.w / 2, y: (n.y ?? 0) - n.h / 2 }));
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const out: Record<string, { x: number; y: number }> = {};
  for (const b of boxes) out[b.id] = { x: Math.round(b.x - minX + 60), y: Math.round(b.y - minY + 48) };
  return out;
}
