// Team canvas geometry (#2193) — pure math for the relationship graph, ported from the Claude Design
// prototype. Kept React-free so it's unit-testable and the canvas component stays a thin renderer.
// The graph lives in a fixed 1120×800 design space; the canvas scales it by a zoom factor.
import { forceSimulation, forceLink, forceManyBody, forceX, forceCollide, type SimulationNodeDatum } from "d3-force";
import { graphEdge } from "@/shared/lib/graph/edgePath";
import { layerDag } from "@/shared/lib/graph/layers";
import { findBackEdges } from "@/shared/lib/graph/cycles";
import { orderLayers } from "@/shared/lib/graph/order";
import type { GraphEdge } from "@/shared/lib/graph/types";
import type { Team, Position, PositionKind } from "./team";

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

/** The tight bounding box around every placed node in `positions` (design-space), or null when there are
 *  none. Framing (fit / saved-zoom restore) centers on THIS — where the nodes actually are — instead of
 *  the fixed CANVAS box, so the graph isn't parked high / clipped when the layout fills only part of (or
 *  overflows) the canvas (#2673). Pure. */
export function contentBounds(positions: Position[]): Box | null {
  if (positions.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of positions) {
    const b = nodeBox(p);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
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
  // The shared graph line-type (#2222); Team keeps its own arrowhead markers, so it only takes the
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

// ── Auto-organize ────────────────────────────────────────────────────────────
/** Archetypes that impose a top-down hierarchy (a parent → child flow); peers/consults are lateral and
 *  don't drive layering. */
const HIERARCHY_ARCHETYPES = new Set(["manages", "serves", "oversees", "stewards"]);

const AUTO_COL = 230; // seed horizontal spacing between nodes in a layer (before force refinement)
/** Vertical gap between hierarchy layers (fixed once assigned — keeps rows clean). Exported for the
 *  #2451 row-alignment regression tests (center-y deltas between laid-out nodes are multiples of it). */
export const AUTO_ROW = 200;

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
 *  fixed-y force refinement build on. Exported for the #2418 layer-parity tests.
 *
 *  Since #2418 this delegates to the shared graph core: `layerDag` (longest-path layering, #2214) over
 *  the hierarchy edges with `findBackEdges` (#2217) as the cycle-break set, then `orderLayers` (the
 *  shared barycenter sweep) with org's tunables — 4 sequential passes, cross-layer hierarchy neighbors.
 *  Acyclic layer assignments are identical to the old private layerer; a cycle now breaks by DROPPING
 *  the DFS back-edge (the forward edge still layers parent-above-child) instead of the old zero-the-
 *  on-stack-parent artifact. */
export function layerNodes(org: Team): LayerResult {
  const ids = org.positions.map((p) => p.nodeId);
  const idSet = new Set(ids);
  // The hierarchy sub-graph: only top-down archetypes drive layering; parent → child is exactly
  // layerDag's "from → deeper" convention.
  const hierarchy: GraphEdge[] = org.relationships
    .filter((r) => HIERARCHY_ARCHETYPES.has(r.archetype) && idSet.has(r.from) && idSet.has(r.to))
    .map((r) => ({ id: r.id, from: r.from, to: r.to }));

  const { backEdgeIds } = findBackEdges(ids, hierarchy);
  const layerRec = layerDag(ids, hierarchy, backEdgeIds);
  const layer = new Map<string, number>(ids.map((n) => [n, layerRec[n]]));

  // Crossing reduction: a node's pull comes from its hierarchy parents+children in OTHER layers
  // (lateral archetypes don't reorder rows; back-edges still pull, as before).
  const parents = new Map<string, string[]>(ids.map((n) => [n, []]));
  const children = new Map<string, string[]>(ids.map((n) => [n, []]));
  for (const e of hierarchy) { parents.get(e.to)!.push(e.from); children.get(e.from)!.push(e.to); }
  const order = orderLayers(
    ids,
    (n) => layer.get(n)!,
    (n) => { const l = layer.get(n)!; return [...parents.get(n)!, ...children.get(n)!].filter((m) => layer.get(m) !== l); },
    { passes: 4 },
  );
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
 *  re-running "Auto organize" reproduces the same layout. Returns fresh top-left `{x,y}` per nodeId.
 *
 *  `sizes` optionally overrides a node's box per nodeId (#2451): a synthetic pool node in a collapsed
 *  org renders as a STACKED card (agent card + shadow-stack overhang), so the collision pass must see
 *  that real footprint — not the plain agent size its `kind` implies. */
export function autoLayout(org: Team, sizes?: Record<string, { w: number; h: number }>): Record<string, { x: number; y: number }> {
  const { layer, order } = layerNodes(org);
  const rowY = (l: number) => 60 + l * AUTO_ROW;

  // Seed each node at its row (center coords), spread horizontally by its in-layer order so the force
  // pass starts from a sane, crossing-reduced arrangement rather than a random cloud.
  const nodes: SimNode[] = org.positions.map((p) => {
    const l = layer.get(p.nodeId)!;
    const row = order.get(l)!;
    const idx = row.indexOf(p.nodeId);
    const { w, h } = sizes?.[p.nodeId] ?? NODE_SIZE[p.kind];
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
