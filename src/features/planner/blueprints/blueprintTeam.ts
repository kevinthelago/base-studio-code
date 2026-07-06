// Blueprint team (#2450) — the pure model behind a blueprint's embedded org configuration.
// FORK-ON-ATTACH is the core rule: authoring starts by DEEP-COPYING a library org (or blank)
// into `blueprint.team` (structuredClone at the boundary), so edits to the blueprint's team
// never mutate the library org and library edits never ripple into blueprints — the blueprint
// artifact stays reproducible. The `bsc org` store remains the archetype library.
//
// Pure (no React/Tauri) so it's unit-testable; the Team author view (authorViews/TeamView.tsx)
// drives every edit through the immutable helpers below and emits the whole blueprint via
// `onChange`, like every other author view.

// Type-only cross-feature imports (allowed by the #1545 boundary).
import type { Org, Position, Relationship } from "@/features/org";
import type { BlueprintTeam } from "../stages/blueprintTypes";

/** A blank team — the "start from scratch" archetype choice. */
export function blankTeam(): BlueprintTeam {
  return { positions: [], relationships: [] };
}

/** Fork a library org into a blueprint team: a DEEP COPY of its graph (positions + relationships
 *  + layout coords), dropping the org-library identity (`id`/`name`/`blurb`/`builtin`). The clone
 *  is the isolation boundary — neither side can reach the other's objects afterwards. */
export function forkTeamFromOrg(org: Pick<Org, "positions" | "relationships">): BlueprintTeam {
  return structuredClone({ positions: org.positions, relationships: org.relationships });
}

/** Wrap a blueprint's team as a synthetic {@link Org} so the org feature's pure machinery
 *  (canvas geometry, `deriveCommunication`, `autoLayout`, the inspector) can read it unchanged.
 *  The wrapper SHARES the team's arrays — it is a read lens, never a mutation target. */
export function teamAsOrg(team: BlueprintTeam, name = "Blueprint team"): Org {
  return { id: "__blueprint-team__", name, positions: team.positions, relationships: team.relationships };
}

// ── Immutable edit helpers (mirror the org slice's verbs, minus the store) ──────────────────────

/** Add a position. */
export function teamAddPosition(team: BlueprintTeam, position: Position): BlueprintTeam {
  return { ...team, positions: [...team.positions, position] };
}

/** Patch a position by nodeId (label, persona, x/y, …). The nodeId itself is immutable. */
export function teamUpdatePosition(
  team: BlueprintTeam, nodeId: string, patch: Partial<Omit<Position, "nodeId">>,
): BlueprintTeam {
  return {
    ...team,
    positions: team.positions.map((p) => (p.nodeId === nodeId ? { ...p, ...patch, nodeId: p.nodeId } : p)),
  };
}

/** Remove a position and every relationship touching it (the graph stays well-formed). */
export function teamRemovePosition(team: BlueprintTeam, nodeId: string): BlueprintTeam {
  return {
    positions: team.positions.filter((p) => p.nodeId !== nodeId),
    relationships: team.relationships.filter((r) => r.from !== nodeId && r.to !== nodeId),
  };
}

/** Add a relationship edge. */
export function teamAddRelationship(team: BlueprintTeam, relationship: Relationship): BlueprintTeam {
  return { ...team, relationships: [...team.relationships, relationship] };
}

/** Patch a relationship by id (e.g. change its archetype). The id itself is immutable. */
export function teamUpdateRelationship(
  team: BlueprintTeam, relationshipId: string, patch: Partial<Omit<Relationship, "id">>,
): BlueprintTeam {
  return {
    ...team,
    relationships: team.relationships.map((r) => (r.id === relationshipId ? { ...r, ...patch, id: r.id } : r)),
  };
}

/** Remove a relationship by id. */
export function teamRemoveRelationship(team: BlueprintTeam, relationshipId: string): BlueprintTeam {
  return { ...team, relationships: team.relationships.filter((r) => r.id !== relationshipId) };
}

/** Apply an auto-layout result ({nodeId → {x,y}}) to the team's positions. */
export function teamApplyLayout(
  team: BlueprintTeam, layout: Record<string, { x: number; y: number }>,
): BlueprintTeam {
  return { ...team, positions: team.positions.map((p) => ({ ...p, ...layout[p.nodeId] })) };
}
