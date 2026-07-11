// Teams-overview layout (#2742) — the NEW top graph level: every team is a card laid out in a grid, so
// the user navigates teams IN the graph (click a card to enter) instead of a header dropdown. Pure +
// deterministic (no Date/Math.random), so `teamsBounds` can drive the viewport fit exactly like the
// per-team `contentBounds`. Card boxes are in the same design space as position `nodeBox`es.
import type { Box } from "./orgLayout";
import { positionDisplay } from "./orgView";
import type { Team } from "./team";
import type { Persona } from "@/features/personas";

export const TEAM_CARD_W = 288;
export const TEAM_CARD_H = 160;
const GAP_X = 40;
const GAP_Y = 44;
const ORIGIN_X = 60;
const ORIGIN_Y = 56;

/** Column count for `count` cards — a squarish grid, capped at 3 wide so cards stay readable. */
function columns(count: number): number {
  return Math.max(1, Math.min(3, Math.ceil(Math.sqrt(Math.max(1, count)))));
}

/** Grid boxes for `count` cells (team cards + the trailing "new team" card), row-major. */
export function teamsGrid(count: number): Box[] {
  const cols = columns(count);
  return Array.from({ length: count }, (_, i) => {
    const r = Math.floor(i / cols), c = i % cols;
    return {
      x: ORIGIN_X + c * (TEAM_CARD_W + GAP_X),
      y: ORIGIN_Y + r * (TEAM_CARD_H + GAP_Y),
      w: TEAM_CARD_W, h: TEAM_CARD_H,
    };
  });
}

/** The tight bounding box around all `count` cells — what the viewport fits/centers on (#2673-style). */
export function teamsBounds(count: number): Box | null {
  if (count <= 0) return null;
  const boxes = teamsGrid(count);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export interface TeamStats {
  positions: number;
  agents: number;
  resources: number;
  externals: number;
  /** Distinct departments present (from each position's `positionDisplay(...).dept`). */
  depts: string[];
}

/** Headline counts for a team card (positions by kind + the department spread). Pure. */
export function teamStats(team: Team, personas: Persona[]): TeamStats {
  const positions = team.positions.length;
  const agents = team.positions.filter((p) => p.kind === "agent").length;
  const resources = team.positions.filter((p) => p.kind === "resource").length;
  const externals = team.positions.filter((p) => p.kind === "external").length;
  const depts = [...new Set(team.positions.map((p) => positionDisplay(p, personas).dept))];
  return { positions, agents, resources, externals, depts };
}
