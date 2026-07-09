// Node-push geometry (#2662) — when the terminal morph GROWS in the graph, neighbour nodes that overlap
// its panel get shoved out of the way so it makes room (and their edges follow). Pure so the displacement
// is unit-tested in isolation; the canvas applies it as a transform + re-routes the affected edges.
import { NW, NH } from "./glanceGraph";

/** The expanded panel's world box — reported by the morph, consumed by the canvas. */
export interface MorphRect { left: number; top: number; w: number; h: number }

/** Clearance (world px) a neighbour node keeps from the expanded terminal panel. */
export const PUSH_MARGIN = 28;

/** How far to shove a node at (nx,ny) so its box clears the panel `r` — the minimal push out the nearest
 *  edge (AABB min-penetration axis). {0,0} when it doesn't overlap. Pure. */
export function pushAway(nx: number, ny: number, r: MorphRect): { dx: number; dy: number } {
  const dxc = (nx + NW / 2) - (r.left + r.w / 2);
  const dyc = (ny + NH / 2) - (r.top + r.h / 2);
  const ox = (r.w / 2 + NW / 2 + PUSH_MARGIN) - Math.abs(dxc);
  const oy = (r.h / 2 + NH / 2 + PUSH_MARGIN) - Math.abs(dyc);
  if (ox <= 0 || oy <= 0) return { dx: 0, dy: 0 };            // no overlap → no push
  return ox < oy ? { dx: dxc < 0 ? -ox : ox, dy: 0 } : { dx: 0, dy: dyc < 0 ? -oy : oy };
}
