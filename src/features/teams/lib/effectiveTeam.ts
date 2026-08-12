// Effective team resolution (#3152, part of the Teams-in-Planner epic #3151) — a project's team can
// come from two places: its OWN per-project binding (planner-owned storage, `bsc plan team get/set`,
// decoupled from the blueprint per option (b)) or the BLUEPRINT it was seeded from (`blueprint.team`,
// #2450, a reusable template). The binding wins once a project has pinned its own team; an unset
// binding falls back to the blueprint's team so a project that never re-pins keeps working exactly as
// before (#3101/#3102 seeding stays byte-identical). Pure (no React/Tauri/bsc) so both this feature
// and the planner's fleet-seeding path (`teamFleet.ts`) can unit-test the precedence directly.
import type { Position, Relationship } from "./team";

/** The minimal team shape this resolver needs — structurally the same as this feature's {@link Team}
 *  minus its library-identity fields (id/name/blurb/builtin), and the same shape the planner's
 *  `BlueprintTeam` and a `bsc plan team get` blob carry. Kept local (not imported from the planner) so
 *  this feature never depends on it — the planner depends on teams, never the reverse. */
export interface TeamGraph {
  positions: Position[];
  relationships: Relationship[];
}

/**
 * Resolve a project's EFFECTIVE team: its per-project `binding` (from `bsc plan team get`) if one has
 * ever been set, else the `blueprintTeam` it was seeded from. `binding` is `null`/`undefined` exactly
 * when no per-project team has been set yet (the planner's blob store returns nothing until the first
 * `bsc plan team set`) — that, and only that, is what falls back; an explicitly-set EMPTY binding
 * (`{ positions: [], relationships: [] }`, a project deliberately unpinning its team) still wins, since
 * it is a real, its own recorded decision.
 */
export function effectiveTeam(
  binding: TeamGraph | null | undefined,
  blueprintTeam: TeamGraph | undefined,
): TeamGraph | undefined {
  return binding ?? blueprintTeam;
}
