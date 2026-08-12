// The commons + integration LANES (#851, retasked by #funnel-commons-and-integration-streams).
//
// Originally this module gated feature streams on a commons SENTINEL that the DIRECTOR satisfied:
// `commons` was not a real stream, it was a latch, and the director held a write carve-out so it
// could scaffold `.gitignore` / `package.json` / CI config itself. The three-tier funnel takes the
// director's write away, so that owner has to go somewhere — and all three of the duties it loses
// (steward the commons, merge the integration branch + revert it when red, run the cross-feature
// seam tests) are DOING work. Doing is a worker's job.
//
// So the sentinel becomes a real lane with a real worktree, and a second lane takes the integration
// branch. Four pure transforms over a FleetPlan, applied at launch (and usable in the planner/UI):
//
//   1. excludeCommonsFromStreams — strip every commons path from each FEATURE stream's `owns`, so no
//      feature stream owns `.gitignore` / `package.json` / CI config (the single-owner rule, by
//      construction). The commons lane owns them instead.
//   2. gateStreamsOnCommons — Phase 0: every feature stream `dependsOn` its repo's commons lane, so
//      the commons are scaffolded and landed BEFORE feature workers build against them.
//   3. commonsLanesFor — materialize the lanes themselves, one pair PER REPO (see the note on
//      `laneIdFor`).
//   4. applyCommonsGate — all three, in the order that matters.
//
// Pure (no store/IO) so it's exhaustively unit-testable; `fleetStartProject` calls `applyCommonsGate`
// with the project's stack-derived commons.

import type { FleetPlan, AgentStream } from "./planFleet";
import { excludeCommonsFromOwns } from "@/shared/lib/session/commons";
import { matchGlob } from "@/shared/lib/session/sessionRoles";

/**
 * Stream id for the commons lane — the single owner of the repo-root commons (#851). It USED to be a
 * reserved sentinel that no real stream carried (the director satisfied it); it is now a real stream
 * id, so it names a branch, a worktree and a pane like any other lane.
 */
export const COMMONS_STREAM_ID = "commons";

/**
 * Stream id for the integration lane — owner of the integration branch: the local merges, the revert
 * when the branch goes red, and the cross-feature seam tests. Under local-first there are no PRs, so
 * this lane's whole job is local: it never reaches a remote.
 */
export const INTEGRATION_STREAM_ID = "integration";

/**
 * The lane id for `base` in `repo`. The commons are a property of a REPO ROOT, not of a project — two
 * repos have two `.gitignore`s and two lockfiles, and one owner cannot hold both (it gets one
 * worktree). So a multi-repo fleet gets one pair of lanes per repo, suffixed with the repo slug.
 *
 * The single-repo case — which is nearly every fleet — keeps the bare `commons` / `integration` ids,
 * so branch names, pane ids and the `dependsOn` sentinel read exactly as they did before.
 */
export function laneIdFor(base: string, repo: string, multiRepo: boolean): string {
  if (!multiRepo) return base;
  const slug = repo.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug ? `${base}--${slug}` : base;
}

/** The distinct repos the feature streams build in, in first-seen order. */
function reposOf(streams: AgentStream[]): string[] {
  const out: string[] = [];
  for (const s of streams) if (s.repo && !out.includes(s.repo)) out.push(s.repo);
  return out;
}

/** Strip every commons path from each feature stream's `owns` (the owns-exclusion). Pure; returns a
 *  new array. A stream that already excludes the commons is unchanged. */
export function excludeCommonsFromStreams(streams: AgentStream[], commons: string[]): AgentStream[] {
  return streams.map((s) => {
    const owns = excludeCommonsFromOwns(s.owns, commons, matchGlob);
    return owns.length === s.owns.length ? s : { ...s, owns };
  });
}

/**
 * Phase 0 gating (#851 step 3): make every feature stream depend on ITS OWN REPO's commons lane, so
 * the commons are landed before feature workers build against them. Adds the lane id to each stream's
 * `dependsOn` (deduped). A no-op when there are no commons. Pure; returns new stream objects only
 * where the dep was added.
 *
 * No longer conditioned on a director existing (it was, when the director was the commons owner): the
 * commons lane is a worker, so the gate holds in a director-less fleet exactly as it does with one.
 */
export function gateStreamsOnCommons(streams: AgentStream[], commons: string[]): AgentStream[] {
  if (commons.length === 0) return streams;
  const multiRepo = reposOf(streams).length > 1;
  return streams.map((s) => {
    const id = laneIdFor(COMMONS_STREAM_ID, s.repo, multiRepo);
    return s.dependsOn.includes(id) ? s : { ...s, dependsOn: [...s.dependsOn, id] };
  });
}

/**
 * Materialize the commons + integration lanes for `streams` — one pair per distinct repo.
 *
 * The commons lane OWNS the commons globs (it is the single owner the exclusion above carved out for
 * it) and depends on nothing, so it runs in the first wave. The integration lane owns no source at
 * all — its artifacts are merges, a revert, and seam-test runs — and it depends on the commons lane,
 * since there is nothing coherent to integrate until the commons have landed.
 *
 * Both are ORDINARY streams (#funnel-commons-and-integration-streams): they launch with the fleet and
 * END when their work is done, exactly like a feature worker. Nothing parks them alive and nothing but
 * the user restarts them — the maintenance parking that once would have kept them warm was removed on
 * purpose (`#session-stop-is-honoured`), because it depended on a Stop hook that refused a worker's
 * stop and so made sessions unkillable.
 */
export function commonsLanesFor(streams: AgentStream[], commons: string[]): AgentStream[] {
  if (commons.length === 0) return [];
  const repos = reposOf(streams);
  if (repos.length === 0) return [];
  const multiRepo = repos.length > 1;
  const lanes: AgentStream[] = [];
  for (const repo of repos) {
    const commonsId = laneIdFor(COMMONS_STREAM_ID, repo, multiRepo);
    lanes.push({
      id: commonsId,
      name: multiRepo ? `Commons (${repo})` : "Commons",
      repo,
      owns: [...commons],
      issues: [],
      dependsOn: [],
    });
    lanes.push({
      id: laneIdFor(INTEGRATION_STREAM_ID, repo, multiRepo),
      name: multiRepo ? `Integration (${repo})` : "Integration",
      repo,
      // Owns no source: this lane merges, reverts and runs seam tests. Giving it globs would make it
      // a second writer on someone else's lane, which is the exact collision #851 exists to prevent.
      owns: [],
      issues: [],
      dependsOn: [commonsId],
    });
  }
  return lanes;
}

/** True when `id` names one of the two lanes (either the bare id or a per-repo suffixed one). */
export function isLaneStream(id: string): boolean {
  return (
    id === COMMONS_STREAM_ID ||
    id === INTEGRATION_STREAM_ID ||
    id.startsWith(`${COMMONS_STREAM_ID}--`) ||
    id.startsWith(`${INTEGRATION_STREAM_ID}--`)
  );
}

/**
 * Apply the commons model to a fleet plan: exclude the commons from every feature stream's `owns`,
 * gate each on its repo's commons lane, then PREPEND the lanes themselves.
 *
 * Order is load-bearing. The exclusion must run on the feature streams ALONE — if the commons lane
 * were already in the list, the exclusion would strip the very globs that make it the owner and the
 * commons would end up owned by nobody. Prepending last also puts the lanes at the head of the launch
 * order, which is what Phase 0 means. Returns a new plan; the director and other fields pass through.
 */
export function applyCommonsGate(fleet: FleetPlan, commons: string[]): FleetPlan {
  const excluded = excludeCommonsFromStreams(fleet.streams, commons);
  const gated = gateStreamsOnCommons(excluded, commons);
  const lanes = commonsLanesFor(fleet.streams, commons);
  return { ...fleet, streams: [...lanes, ...gated] };
}
