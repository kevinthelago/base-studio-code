// Org canvas geometry (#2193) — pure math for the relationship graph, ported from the Claude Design
// prototype. Kept React-free so it's unit-testable and the canvas component stays a thin renderer.
// The graph lives in a fixed 1120×800 design space; the canvas scales it by a zoom factor.
import type { Position, PositionKind } from "./org";

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
  const acx = A.x + A.w / 2, acy = A.y + A.h / 2, bcx = B.x + B.w / 2, bcy = B.y + B.h / 2;
  const [p1x, p1y] = anchor(A, bcx, bcy);
  let [p2x, p2y] = anchor(B, acx, acy);
  const dx0 = p2x - p1x, dy0 = p2y - p1y, L = Math.hypot(dx0, dy0) || 1;
  p2x -= (dx0 / L) * 9;
  p2y -= (dy0 / L) * 9;
  const dx = p2x - p1x, dy = p2y - p1y;
  const nx = -dy / L, ny = dx / L;
  const c1x = p1x + dx * 0.35 + nx * bow, c1y = p1y + dy * 0.35 + ny * bow;
  const c2x = p1x + dx * 0.65 + nx * bow, c2y = p1y + dy * 0.65 + ny * bow;
  const f = (v: number) => Math.round(v * 10) / 10;
  const d = `M ${f(p1x)} ${f(p1y)} C ${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(p2x)} ${f(p2y)}`;
  // The cubic's midpoint (t=0.5) via the Bernstein weights (1/8, 3/8, 3/8, 1/8).
  const lx = 0.125 * p1x + 0.375 * c1x + 0.375 * c2x + 0.125 * p2x;
  const ly = 0.125 * p1y + 0.375 * c1y + 0.375 * c2y + 0.125 * p2y;
  return { d, lx, ly };
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
