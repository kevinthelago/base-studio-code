// Team → fleet (#3101 / #3102): a project's TEAM (its persona-relationship graph, `blueprint.team`)
// seeds the fleet's ROLE-ACTOR streams. A team agent position bound to a lifecycle-role persona —
// curator, documentor, reviewer, tester, juror, issuer — becomes a fleet stream that launches WITH the
// fleet (at the project hub; the launch composition + hub cwd land in A-2), so "an actor is present if
// it's in the project's team" (#3101).
//
// WORKERS are deliberately NOT seeded here: a worker needs `owns` globs + `issues` only the planner can
// size, so worker/engineer positions stay planner-owned. The DIRECTOR is its own launch slot
// (`FleetDirector`), TRIAGE is per-repo, and the standing Studio roles (designer/architect/librarian) +
// the planner aren't fleet members — so none of those seed either. The MARKETER is opt-in (#2431): it
// only seeds when a team explicitly places one (Fleet Alpha does, #3143), never by default elsewhere.
//
// Pure (no React/Tauri) so it's unit-testable; the launch path (`usePlanPublish`, A-2) composes the
// result into the `FleetPlan` before `fleetStartProject`.
import type { BlueprintTeam } from "../stages/blueprintTypes";
import type { Persona } from "@/features/personas";
import type { SessionRole } from "@/shared/lib/session/sessionRoles";
import type { AgentStream } from "./planFleet";

/** The lifecycle role-actors a team position may seed into the fleet — project-wide singletons with no
 *  owned globs/issues (unlike a worker). One session each; deduped by role so a team never launches two
 *  curators/documentors/… and a planner-authored stream for a role always wins over the team's. */
export const SEEDABLE_TEAM_ROLES: ReadonlySet<SessionRole> = new Set<SessionRole>([
  "curator", "documentor", "reviewer", "tester", "juror", "issuer", "marketer",
]);

/** Slug a team position's `nodeId` into a fleet stream id: lowercase, `[a-z0-9-]`, collapsed — so it is
 *  safe as a pane-id tail (`<key>:<id>`) and a git branch name. Empty → `"role"`. */
function streamIdFromNode(nodeId: string): string {
  return (
    nodeId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "") || "role"
  );
}

/**
 * Derive the extra fleet streams a project's TEAM contributes — one per team agent position whose
 * persona is a {@link SEEDABLE_TEAM_ROLES} lifecycle actor, deduped by role against BOTH the planner's
 * existing streams and each other (these roles are singletons). Deterministic (positions in author
 * order). Returns `[]` for no team / no seedable positions.
 *
 * Each derived stream carries only its `persona` reference (which resolves role/prompt/skills/model at
 * launch) with empty `owns`/`issues`/`dependsOn` and an empty `repo` — a role-actor runs project-wide at
 * the hub, not inside a per-stream repo worktree (the launch routes it there in A-2).
 *
 * @param team      the project's blueprint team (positions + relationships), or undefined
 * @param personas  the persona library (resolves a position's `personaId` → its role/name)
 * @param existing  the planner's fleet streams — a role already covered by one is NOT re-seeded
 */
export function teamRoleStreams(
  team: BlueprintTeam | undefined,
  personas: Persona[],
  existing: ReadonlyArray<Pick<AgentStream, "persona">>,
): AgentStream[] {
  if (!team || team.positions.length === 0) return [];
  const byId = new Map(personas.map((p) => [p.id, p]));
  // Roles already present among the planner's streams (via each stream's persona) — never double a role.
  const covered = new Set<SessionRole>();
  for (const s of existing) {
    const role = s.persona ? byId.get(s.persona)?.role : undefined;
    if (role) covered.add(role);
  }
  const out: AgentStream[] = [];
  const seenIds = new Set<string>();
  for (const pos of team.positions) {
    if (pos.kind !== "agent" || !pos.personaId) continue;
    const persona = byId.get(pos.personaId);
    if (!persona || !SEEDABLE_TEAM_ROLES.has(persona.role)) continue;
    if (covered.has(persona.role)) continue; // a planner stream (or an earlier team position) owns this role
    covered.add(persona.role);
    let id = streamIdFromNode(pos.nodeId);
    while (seenIds.has(id)) id = `${id}-1`; // guard a pathological nodeId-slug collision
    seenIds.add(id);
    out.push({
      id,
      name: pos.label?.trim() || persona.name || persona.role,
      repo: "", // hub-scoped: runs at the project hub (A-2), not a repo worktree
      owns: [],
      issues: [],
      dependsOn: [],
      persona: persona.id,
    });
  }
  return out;
}
