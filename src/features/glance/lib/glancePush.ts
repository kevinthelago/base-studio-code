// Node-parting geometry (#2671, supersedes the #2666 d3-force relaxation) — when the terminal morph GROWS
// in the graph (#2534/#2662), the neighbourhood PARTS to make room in four rigid "curtains" (left/right/
// up/down), split by the panel's aspect-scaled diagonals. Each curtain translates as ONE block by the
// clearance its most-penetrating member needs, so:
//   1. every neighbour clears the panel BY CONSTRUCTION — a hard guarantee the old soft, alpha-scaled
//      force could not make (it settled at equilibrium with residual penetration → the visible clipping);
//   2. nodes never clip INTO each other either — a curtain shifts RIGIDLY, so members keep their exact
//      relative spacing (the whole region slides aside, like curtains parting), and orthogonal curtains
//      move away from their shared diagonal.
// Closed-form + deterministic (no simulation, no tuning knobs): the same rect always yields the same
// offsets — no jitter — and it's cheap enough to recompute live during a resize drag. Pure (React/DOM-
// free) so the clearance guarantee + the rigid spacing are unit-tested in isolation. The canvas animates
// each node's offset AND the panel's grow off one matched easing, so the two read as a single motion.
import { NW, NH } from "./glanceGraph";

/** The expanded panel's world box — reported by the morph, consumed by the canvas. */
export interface MorphRect { left: number; top: number; w: number; h: number }

/** Clearance (world px) every neighbour keeps from the expanded terminal panel. */
export const PUSH_MARGIN = 36;

type Dir = "left" | "right" | "up" | "down";

/**
 * Per-node box offset so the graph PARTS to make room for the open panel `rect` — the four-curtain model.
 * Each neighbour is assigned to a curtain by which side of the panel it sits on (the panel's aspect-scaled
 * diagonals decide the dominant axis), then every curtain translates as one rigid block by the largest
 * clearance any of its members needs. Result: the panel is cleared by construction (no node clips into it)
 * and every curtain keeps its internal spacing (no node clips into a neighbour). Returns a
 * `nodeId → {dx,dy}` map of the NON-ZERO shifts only; `excludeId` (the grown node, under the panel) is
 * omitted. Pure + deterministic.
 */
export function partAroundPanel(
  nodes: { id: string; x: number; y: number }[],
  rect: MorphRect,
  excludeId?: string,
): Map<string, { dx: number; dy: number }> {
  const out = new Map<string, { dx: number; dy: number }>();
  const cx0 = rect.left + rect.w / 2, cy0 = rect.top + rect.h / 2;
  const hx = rect.w / 2, hy = rect.h / 2;
  // The Minkowski-expanded forbidden box for a node CENTRE: the panel grown by the node's half-extent +
  // the margin. A node centre inside this box means its card overlaps the panel (within the margin).
  const fx0 = rect.left - NW / 2 - PUSH_MARGIN, fx1 = rect.left + rect.w + NW / 2 + PUSH_MARGIN;
  const fy0 = rect.top - NH / 2 - PUSH_MARGIN, fy1 = rect.top + rect.h + NH / 2 + PUSH_MARGIN;

  // Pass 1 — assign each node to a curtain and record the max clearance that curtain must provide.
  const need: Record<Dir, number> = { left: 0, right: 0, up: 0, down: 0 };
  const dirOf = new Map<string, Dir>();
  for (const n of nodes) {
    if (n.id === excludeId) continue;
    const cx = n.x + NW / 2, cy = n.y + NH / 2;
    // Wedge by the panel's diagonals, scaled to its aspect: whichever axis the node is more displaced
    // along (relative to the panel's half-size) wins, so the split lines run corner-to-corner.
    const dir: Dir =
      Math.abs(cx - cx0) / hx >= Math.abs(cy - cy0) / hy
        ? (cx < cx0 ? "left" : "right")
        : (cy < cy0 ? "up" : "down");
    dirOf.set(n.id, dir);
    // If this node overlaps the panel, the distance to slide it out of the forbidden box along its
    // curtain's OWN axis (always positive for an overlapper, since its centre is inside the box).
    if (cx > fx0 && cx < fx1 && cy > fy0 && cy < fy1) {
      const exit = dir === "left" ? cx - fx0 : dir === "right" ? fx1 - cx : dir === "up" ? cy - fy0 : fy1 - cy;
      if (exit > need[dir]) need[dir] = exit;
    }
  }

  // Pass 2 — every member of a curtain takes that curtain's block shift (rigid → spacing preserved).
  const vec: Record<Dir, { dx: number; dy: number }> = {
    left: { dx: -need.left, dy: 0 }, right: { dx: need.right, dy: 0 },
    up: { dx: 0, dy: -need.up }, down: { dx: 0, dy: need.down },
  };
  for (const n of nodes) {
    const dir = dirOf.get(n.id);
    if (!dir) continue;
    const v = vec[dir];
    if (v.dx || v.dy) out.set(n.id, v);
  }
  return out;
}
