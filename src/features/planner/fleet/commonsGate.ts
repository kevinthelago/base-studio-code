// Director-owned commons gating for the fleet (#851). Two pure transforms applied to a FleetPlan at
// launch (and usable in the planner/UI), built on the stack-derived commons set
// (`commonsGlobsForStack`):
//
//   1. excludeCommonsFromStreams — strip every commons path from each feature stream's `owns`, so no
//      feature stream owns `.gitignore` / `package.json` / CI config (the single-owner rule, by
//      construction). The director owns the commons.
//   2. gateStreamsOnCommons — Phase 0: every feature stream `dependsOn` the COMMONS sentinel, so the
//      director scaffolds + lands the complete commons on develop BEFORE feature workers build
//      against them. Workers start against complete commons and never need to touch them.
//
// Pure (no store/IO) so it's exhaustively unit-testable; `fleetStartProject` calls these with the
// project's stack to wire the director's writeGlobs + the feature gating.

import type { FleetPlan, AgentStream } from "./planFleet";
import { excludeCommonsFromOwns } from "@/shared/lib/session/commons";
import { matchGlob } from "@/shared/lib/session/sessionRoles";

/**
 * Reserved stream id the feature streams depend on for "the director has scaffolded + landed the
 * commons" (#851 Phase 0). It is NOT a real stream — the DIRECTOR satisfies it (it owns the commons)
 * — so it never collides with a planner-authored stream id and the coordinator treats it as the
 * commons-landed latch. Workers carry it in `dependsOn` purely as the launch/coordination gate.
 */
export const COMMONS_STREAM_ID = "commons";

/** Strip every commons path from each feature stream's `owns` (the owns-exclusion). Pure; returns a
 *  new array. A stream that already excludes the commons is unchanged. */
export function excludeCommonsFromStreams(streams: AgentStream[], commons: string[]): AgentStream[] {
  return streams.map((s) => {
    const owns = excludeCommonsFromOwns(s.owns, commons, matchGlob);
    return owns.length === s.owns.length ? s : { ...s, owns };
  });
}

/**
 * Phase 0 gating (#851 step 3): make every feature stream depend on the commons being landed, so the
 * director scaffolds them first and feature workers are released only afterward. Adds {@link
 * COMMONS_STREAM_ID} to each stream's `dependsOn` (deduped). A no-op when there is no director to own
 * the commons (a director-less fleet has no commons steward, so nothing gates) or when there are no
 * commons. Pure; returns new stream objects only where the dep was added.
 */
export function gateStreamsOnCommons(streams: AgentStream[], commons: string[], hasDirector: boolean): AgentStream[] {
  if (!hasDirector || commons.length === 0) return streams;
  return streams.map((s) =>
    s.dependsOn.includes(COMMONS_STREAM_ID) ? s : { ...s, dependsOn: [...s.dependsOn, COMMONS_STREAM_ID] },
  );
}

/**
 * Apply both commons transforms to a fleet plan for the given commons set: exclude the commons from
 * every feature stream's `owns`, then gate each on the commons-landed sentinel (when a director
 * exists). Returns a new plan; the director and other fields pass through untouched.
 */
export function applyCommonsGate(fleet: FleetPlan, commons: string[]): FleetPlan {
  const excluded = excludeCommonsFromStreams(fleet.streams, commons);
  const gated = gateStreamsOnCommons(excluded, commons, fleet.director.enabled);
  return { ...fleet, streams: gated };
}
