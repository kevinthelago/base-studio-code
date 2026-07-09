// Node-push geometry (#2662/#2666) — when the terminal morph GROWS in the graph, neighbour nodes that
// overlap its panel move out of the way so it makes room (and their edges follow). A d3-force relaxation
// (the same headless deterministic .stop()+ticks pattern as org/lib/orgLayout) does the shifting: LINK
// springs hold connected nodes at their HOME distances and a weak HOME anchor keeps the graph framed +
// returns it on close, while the panel is a hard OBSTACLE that evicts overlapping nodes each tick — so the
// neighbourhood shifts COHERENTLY (relative distances preserved) instead of each node teleporting on its
// own. Pure (React/DOM-free) so the geometry + the distance-preservation are unit-tested in isolation.
import { forceSimulation, forceLink, forceX, forceY, type SimulationNodeDatum } from "d3-force";
import { NW, NH } from "./glanceGraph";

/** The expanded panel's world box — reported by the morph, consumed by the canvas. */
export interface MorphRect { left: number; top: number; w: number; h: number }

/** Clearance (world px) a neighbour node keeps from the expanded terminal panel. */
export const PUSH_MARGIN = 28;

/** How far to shove a node whose TOP-LEFT is (nx,ny) so its box clears the panel `r` — the minimal push out
 *  the nearest edge (AABB min-penetration axis). {0,0} when it doesn't overlap. Pure. */
export function pushAway(nx: number, ny: number, r: MorphRect): { dx: number; dy: number } {
  const dxc = (nx + NW / 2) - (r.left + r.w / 2);
  const dyc = (ny + NH / 2) - (r.top + r.h / 2);
  const ox = (r.w / 2 + NW / 2 + PUSH_MARGIN) - Math.abs(dxc);
  const oy = (r.h / 2 + NH / 2 + PUSH_MARGIN) - Math.abs(dyc);
  if (ox <= 0 || oy <= 0) return { dx: 0, dy: 0 };            // no overlap → no push
  return ox < oy ? { dx: dxc < 0 ? -ox : ox, dy: 0 } : { dx: 0, dy: dyc < 0 ? -oy : oy };
}

// Force-relax tuning (fixed, like org/lib/orgLayout's — the graph finds its own shape, no user knobs).
const LINK_STR = 0.7;    // how hard edges hold their home length (0–1) — high, so relative distances survive
const HOME_STR = 0.08;   // weak pull back toward each node's home slot — frames the graph + returns it
const OBST_STR = 0.9;    // how hard the panel repels an overlapping node (>> HOME so overlappers mostly clear)
const RELAX_TICKS = 160; // headless ticks to settle (deterministic: d3-force seeds a fixed LCG)

interface RelaxNode extends SimulationNodeDatum { id: string; hx: number; hy: number }

/** A d3 force: the open panel repels any node still overlapping it, toward the nearest edge (its MTV),
 *  scaled by `alpha` like the built-in forces so it fades in step with them → a stable equilibrium where
 *  the LINK springs (holding shape) balance the panel (making room). A SOFT force, not a hard clamp, so
 *  the springs win and a linked cluster flows AROUND the panel coherently instead of being torn across it. */
function panelForce(rect: MorphRect) {
  let ns: RelaxNode[] = [];
  const force = (alpha: number) => {
    for (const n of ns) {
      const { dx, dy } = pushAway((n.x ?? 0) - NW / 2, (n.y ?? 0) - NH / 2, rect);
      if (dx || dy) { n.vx = (n.vx ?? 0) + dx * OBST_STR * alpha; n.vy = (n.vy ?? 0) + dy * OBST_STR * alpha; }
    }
  };
  force.initialize = (nodes: RelaxNode[]) => { ns = nodes; };
  return force;
}

/**
 * Displacement per node so the graph makes room for the open panel `rect` while KEEPING relative distances.
 * A headless d3-force pass seeded at each node's home: link springs at home lengths hold the cluster's
 * shape, a weak home anchor frames it (and returns it on close), and {@link panelForce} repels overlappers.
 * The neighbourhood flows AROUND the panel as one — relative distances largely preserved — rather than each
 * node jumping out on its own. Returns a `nodeId → {dx,dy}` box-offset map (only non-zero shifts);
 * `excludeId` (the grown node, under the panel) is left out. Pure + deterministic → the same rect always
 * yields the same shift (no jitter between frames).
 */
export function relaxAroundPanel(
  nodes: { id: string; x: number; y: number }[],
  links: { source: string; target: string }[],
  rect: MorphRect,
  excludeId?: string,
): Map<string, { dx: number; dy: number }> {
  const out = new Map<string, { dx: number; dy: number }>();
  const sim: RelaxNode[] = nodes
    .filter((n) => n.id !== excludeId)
    .map((n) => ({ id: n.id, hx: n.x + NW / 2, hy: n.y + NH / 2, x: n.x + NW / 2, y: n.y + NH / 2 }));
  if (sim.length === 0) return out;
  const byId = new Map(sim.map((n) => [n.id, n]));

  // Only links whose BOTH ends are in the sim; rest length = the home centre-to-centre distance so the
  // spring's happy place is the graph's original shape.
  const simLinks = links
    .filter((l) => byId.has(l.source) && byId.has(l.target))
    .map((l) => {
      const a = byId.get(l.source)!, b = byId.get(l.target)!;
      return { source: l.source, target: l.target, rest: Math.hypot(a.hx - b.hx, a.hy - b.hy) };
    });

  const s = forceSimulation<RelaxNode>(sim)
    .force("link", forceLink<RelaxNode, (typeof simLinks)[number]>(simLinks).id((d) => d.id).distance((l) => l.rest).strength(LINK_STR))
    .force("homeX", forceX<RelaxNode>((d) => d.hx).strength(HOME_STR))
    .force("homeY", forceY<RelaxNode>((d) => d.hy).strength(HOME_STR))
    .force("panel", panelForce(rect))
    .stop();
  for (let i = 0; i < RELAX_TICKS; i++) s.tick();

  for (const n of sim) {
    const dx = Math.round((n.x! - n.hx) * 100) / 100, dy = Math.round((n.y! - n.hy) * 100) / 100;
    if (dx || dy) out.set(n.id, { dx, dy });
  }
  return out;
}
