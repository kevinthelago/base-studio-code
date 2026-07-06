// Shared edge geometry (#2222, graph design-language #2221) — the ONE line-type every graph draws its
// edges with: a cubic bezier + a filled-triangle arrowhead + a label midpoint, in a shared grammar.
// Only the ROUTING (where the curve meets each card) is layout-dependent (#2226), via `routing`:
//   • "anchor" — perimeter-anchor: leaves each card at the point on its border facing the other card.
//     Right for FREE / ORGANIC layouts (the Org designer's force graph).
//   • "ports"  — side ports: leaves the right (or left) edge at the vertical middle with horizontal
//     control handles. Right for LAYERED left→right graphs (Glance's dependency DAG) — clean columnar
//     flow. (Restores Glance's pre-#2222 geometry; the perimeter router read messy on a layered graph.)
// Both share the arrowhead + label + `bow` (perpendicular separation for parallel/bidirectional/cycle
// edges) + `doubleEnded` (a source arrow for bidirectional relationships). Pure.

export interface EdgeBox { x: number; y: number; w: number; h: number }

export type EdgeRouting = "anchor" | "ports";

export interface GraphEdgeOpts {
  /** Where the curve meets each card. Default "anchor" (perimeter); "ports" for layered graphs. */
  routing?: EdgeRouting;
  /** Perpendicular bow (px) so parallel/bidirectional/cycle edges separate. Default 0. */
  bow?: number;
  /** ("anchor" only) how far short of the target border the curve ends, for the arrow. Default 9. */
  endGap?: number;
  /** Arrowhead length (px); half-width ≈ 0.58×. Default 9. */
  arrowSize?: number;
  /** Also draw an arrowhead at the source (bidirectional). Default false. */
  doubleEnded?: boolean;
}

export interface GraphEdgeGeom {
  /** The cubic-bezier path `d`. */
  d: string;
  /** Filled-triangle arrowhead path at the target border. */
  arrow: string;
  /** Filled-triangle arrowhead at the source border (only when `doubleEnded`). */
  arrowStart?: string;
  /** The curve midpoint — where an edge label pill sits. */
  labelX: number;
  labelY: number;
}

const f = (v: number): number => Math.round(v * 10) / 10;

/** The point on box `a`'s perimeter along the ray toward (tx,ty), with a 3px outset so the line clears
 *  the border. (The Org designer's `anchor` — exported since #2418 replaced org's byte-identical copy;
 *  its feature barrel re-exports this one.) */
export function anchor(a: EdgeBox, tx: number, ty: number): [number, number] {
  const cx = a.x + a.w / 2, cy = a.y + a.h / 2, dx = tx - cx, dy = ty - cy;
  const hw = a.w / 2 + 3, hh = a.h / 2 + 3;
  const sx = dx === 0 ? 1e9 : hw / Math.abs(dx);
  const sy = dy === 0 ? 1e9 : hh / Math.abs(dy);
  const s = Math.min(sx, sy);
  return [cx + dx * s, cy + dy * s];
}

/** A filled-triangle arrow with its tip at (tipx,tipy), pointing along `ang`. */
function arrowPath(tipx: number, tipy: number, ang: number, len: number): string {
  const w = len * 0.58;
  const bx = tipx - Math.cos(ang) * len, by = tipy - Math.sin(ang) * len;
  const nx = -Math.sin(ang), ny = Math.cos(ang);
  return `M ${f(tipx)} ${f(tipy)} L ${f(bx + nx * w)} ${f(by + ny * w)} L ${f(bx - nx * w)} ${f(by - ny * w)} Z`;
}

/** Assemble the geometry from the four control points (source, two handles, arrow tip). Shared by both
 *  routers: the curve ends at `tip`, the arrow sits there, the label is the cubic midpoint. */
function assemble(p1x: number, p1y: number, c1x: number, c1y: number, c2x: number, c2y: number, tipx: number, tipy: number, arrowSize: number, doubleEnded: boolean): GraphEdgeGeom {
  const d = `M ${f(p1x)} ${f(p1y)} C ${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(tipx)} ${f(tipy)}`;
  // The cubic's midpoint (t=0.5) via the Bernstein weights (1/8, 3/8, 3/8, 1/8).
  const labelX = 0.125 * p1x + 0.375 * c1x + 0.375 * c2x + 0.125 * tipx;
  const labelY = 0.125 * p1y + 0.375 * c1y + 0.375 * c2y + 0.125 * tipy;
  const arrow = arrowPath(tipx, tipy, Math.atan2(tipy - c2y, tipx - c2x), arrowSize);
  const arrowStart = doubleEnded ? arrowPath(p1x, p1y, Math.atan2(p1y - c1y, p1x - c1x), arrowSize) : undefined;
  return { d, arrow, arrowStart, labelX, labelY };
}

/** Perimeter-anchor routing — for free/organic layouts. Byte-identical to the Org designer's geometry. */
function anchorEdge(from: EdgeBox, to: EdgeBox, opts: GraphEdgeOpts): GraphEdgeGeom {
  const bow = opts.bow ?? 0, endGap = opts.endGap ?? 9, arrowSize = opts.arrowSize ?? 9;
  const acx = from.x + from.w / 2, acy = from.y + from.h / 2, bcx = to.x + to.w / 2, bcy = to.y + to.h / 2;
  const [p1x, p1y] = anchor(from, bcx, bcy);
  const [b2x, b2y] = anchor(to, acx, acy);       // the target border point — the arrow tip
  const dx0 = b2x - p1x, dy0 = b2y - p1y, L = Math.hypot(dx0, dy0) || 1;
  const p2x = b2x - (dx0 / L) * endGap;          // curve ends short of the border
  const p2y = b2y - (dy0 / L) * endGap;
  const dx = p2x - p1x, dy = p2y - p1y;
  const nx = -dy / L, ny = dx / L;
  const c1x = p1x + dx * 0.35 + nx * bow, c1y = p1y + dy * 0.35 + ny * bow;
  const c2x = p1x + dx * 0.65 + nx * bow, c2y = p1y + dy * 0.65 + ny * bow;
  // NB: the arrow tip is the border point; the curve ends short of it (p2).
  return {
    ...assemble(p1x, p1y, c1x, c1y, c2x, c2y, p2x, p2y, arrowSize, !!opts.doubleEnded),
    arrow: arrowPath(b2x, b2y, Math.atan2(p2y - c2y, p2x - c2x), arrowSize),
  };
}

/** Side-port routing — for layered left→right graphs. Leaves the right (or left) edge at the vertical
 *  middle with horizontal control handles, giving a clean columnar flow. Restores Glance's geometry. */
function portsEdge(from: EdgeBox, to: EdgeBox, opts: GraphEdgeOpts): GraphEdgeGeom {
  const bow = opts.bow ?? 0, arrowSize = opts.arrowSize ?? 9;
  const fRight = from.x < to.x;
  const p1x = from.x + (fRight ? from.w : 0), p1y = from.y + from.h / 2;
  const tLeftPort = to.x >= from.x;
  const tx = to.x + (tLeftPort ? 0 : to.w), ty = to.y + to.h / 2;   // target port — the arrow tip
  const k = Math.max(46, Math.abs(tx - p1x) * 0.5);
  const c1x = p1x + (fRight ? k : -k), c1y = p1y + bow;
  const c2x = tx + (tLeftPort ? -k : k), c2y = ty + bow;
  return assemble(p1x, p1y, c1x, c1y, c2x, c2y, tx, ty, arrowSize, !!opts.doubleEnded);
}

/** The shared line-type between two boxes; `routing` picks the router. See the module header. */
export function graphEdge(from: EdgeBox, to: EdgeBox, opts: GraphEdgeOpts = {}): GraphEdgeGeom {
  return opts.routing === "ports" ? portsEdge(from, to, opts) : anchorEdge(from, to, opts);
}
