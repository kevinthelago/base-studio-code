// Shared edge geometry (#2222, graph design-language #2221) — the ONE line-type every graph draws its
// edges with. A perimeter-anchor cubic bezier: it leaves each card at the point on the card's border
// facing the other card, curves (control points at 0.35/0.65 along the run, offset by `bow` on the
// perpendicular so parallel / bidirectional / cycle edges fan apart), and ends `endGap` px short of the
// target border so a filled-triangle arrowhead sits cleanly on the edge. Pure — generalizes the Org
// designer's `edgeGeometry` (identical curve + label point) and gives Glance the same line (it drops its
// side-port routing). `doubleEnded` adds a source arrow for bidirectional relationships.

export interface EdgeBox { x: number; y: number; w: number; h: number }

export interface GraphEdgeOpts {
  /** Perpendicular bow (px) so parallel/bidirectional/cycle edges separate. Default 0. */
  bow?: number;
  /** How far short of the target border the curve ends, leaving room for the arrow. Default 9. */
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
 *  the border. (The Org designer's `anchor`, kept here so the shared core stays feature-independent.) */
function anchor(a: EdgeBox, tx: number, ty: number): [number, number] {
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

/** The shared line-type between two boxes. See the module header. */
export function graphEdge(from: EdgeBox, to: EdgeBox, opts: GraphEdgeOpts = {}): GraphEdgeGeom {
  const bow = opts.bow ?? 0;
  const endGap = opts.endGap ?? 9;
  const arrowSize = opts.arrowSize ?? 9;
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
  const d = `M ${f(p1x)} ${f(p1y)} C ${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(p2x)} ${f(p2y)}`;
  // The cubic's midpoint (t=0.5) via the Bernstein weights (1/8, 3/8, 3/8, 1/8).
  const labelX = 0.125 * p1x + 0.375 * c1x + 0.375 * c2x + 0.125 * p2x;
  const labelY = 0.125 * p1y + 0.375 * c1y + 0.375 * c2y + 0.125 * p2y;
  const arrow = arrowPath(b2x, b2y, Math.atan2(p2y - c2y, p2x - c2x), arrowSize);
  const arrowStart = opts.doubleEnded ? arrowPath(p1x, p1y, Math.atan2(p1y - c1y, p1x - c1x), arrowSize) : undefined;
  return { d, arrow, arrowStart, labelX, labelY };
}
