// Incremental GitHub sync via updatedAt probes (#2448, epic #2444) — the "version-probe pass" the
// api.rs cache comment anticipated. GraphQL has no ETag, so past the backend TTL a heavy query
// always re-POSTs; these probes make that re-POST conditional on the boards actually having MOVED:
//
//  - Projects set (the planner/glance PROJECTS_QUERY): a light `projectsV2 { id updatedAt }` probe
//    diffs against the persisted githubState records (#2446). Unchanged ⇒ the records themselves
//    are returned (expanded via minimalToGhProject — the round-trip is exact), so the caller's
//    setGithubState re-stamps fetchedAt and the heavy `items(first:100)` scan is skipped entirely.
//    The heavy query is ONE shot for all boards, so the probe gates the whole query, not per board.
//  - Single board (the BOARD/ISSUES/INSIGHTS `node(id)` queries): probe that board's updatedAt and
//    compare with the updatedAt recorded at the LAST heavy fetch of that board. Unchanged ⇒ the
//    heavy query runs with a LONG maxAgeSecs, so the backend TTL cache serves its copy past the
//    default window (extending the maxAgeSecs semantics, not fighting them); moved ⇒ force a
//    fresh POST.
//
// The probes ride the same backend TTL cache (default window), so within the window they are
// cache-hits too — the steady-state cost past the TTL is one light probe per window, and the
// heavy POST only when something actually changed.

import { githubGraphql } from "./github";
import { minimalToGhProject, type GhProjectShape, type MinimalGhProject } from "./githubState";

/** One board as the probes carry it — identity + version cursor only. */
export interface ProbeNode {
  id: string;
  updatedAt: string;
}

/** The light whole-set probe — same `viewer.projectsV2(first:20)` window as PROJECTS_QUERY, but
 *  only the version cursor per board (no items scan, no repositories). */
export const PROJECTS_PROBE_QUERY = `{ viewer { projectsV2(first: 20) { nodes { id updatedAt } } } }`;

/** The light single-board probe for the `node(id)` screens (Board / Issues / Insights). */
export const BOARD_PROBE_QUERY = `query($id:ID!){ node(id:$id){ ... on ProjectV2 { updatedAt } } }`;

/** How long an unchanged board's heavy `node(id)` query may serve the backend's TTL-cached copy.
 *  Long but bounded — the entry is in-memory (process-lifetime) and any real change moves
 *  `updatedAt`, which forces a fresh POST on the next probe. */
export const BOARD_UNCHANGED_MAX_AGE_SECS = 6 * 3600;

/**
 * True when the probe set matches the persisted records exactly — same board ids, same
 * `updatedAt`, nothing added or removed. Any mismatch (a moved board, a new board, a deletion)
 * means the heavy fetch must run.
 */
export function probeMatchesRecords(
  probe: ProbeNode[],
  records: Array<Pick<MinimalGhProject, "id" | "updatedAt">>,
): boolean {
  if (probe.length !== records.length) return false;
  const byId = new Map(records.map((r) => [r.id, r.updatedAt]));
  return probe.every((n) => byId.get(n.id) === n.updatedAt);
}

async function defaultProjectsProbe(): Promise<ProbeNode[]> {
  const d = await githubGraphql<{ viewer?: { projectsV2?: { nodes?: ProbeNode[] } } }>(
    PROJECTS_PROBE_QUERY,
    null,
  );
  return d.viewer?.projectsV2?.nodes ?? [];
}

/**
 * Fetch the published-projects set with the updatedAt probe gating the heavy query (#2448).
 *
 * With a persisted baseline (`records`) and no `force`, the light probe runs first; when nothing
 * moved, the records are re-served (expanded — the minimal round-trip is exact) and the heavy
 * fetch is skipped. A probe failure (offline / rate-limited) falls through to the heavy call,
 * which serves the backend cache or surfaces the real error — exactly the pre-probe behavior.
 *
 * @param fetchHeavy the heavy PROJECTS_QUERY fetch (injected: the query lives in the planner feature).
 * @param records    the persisted githubState records to diff against (null/empty ⇒ no baseline ⇒ heavy).
 * @param force      manual refresh — skip the probe and go straight to the heavy fetch.
 * @param fetchProbe probe override for tests; defaults to the live {@link PROJECTS_PROBE_QUERY}.
 */
export async function fetchProjectsWithProbe(args: {
  fetchHeavy: () => Promise<GhProjectShape[]>;
  records: MinimalGhProject[] | null | undefined;
  force?: boolean;
  fetchProbe?: () => Promise<ProbeNode[]>;
}): Promise<GhProjectShape[]> {
  const { fetchHeavy, records, force, fetchProbe = defaultProjectsProbe } = args;
  if (!force && records?.length) {
    let probe: ProbeNode[] | null = null;
    try {
      probe = await fetchProbe();
    } catch {
      // Fall through to the heavy call (see the contract above).
    }
    if (probe && probeMatchesRecords(probe, records)) return records.map(minimalToGhProject);
  }
  return fetchHeavy();
}

// boardId → the board's updatedAt at the LAST heavy fetch through fetchBoardWithProbe.
// Module-level (like glance's localPublishedCache) so it survives screen remounts;
// process-lifetime, matching the backend cache entries it gates.
const boardBaselines = new Map<string, string>();

/** Test hook: drop the recorded per-board baselines. */
export function resetBoardProbeBaselines(): void {
  boardBaselines.clear();
}

/**
 * The heavy `node(id)` query's cache opts for a probe result vs the recorded baseline (pure).
 * No signal (probe failed, or no baseline yet) ⇒ `{}` — today's default-TTL behavior; unchanged ⇒
 * a long maxAgeSecs so the backend serves its cached copy; moved ⇒ `force` a fresh POST.
 */
export function boardFetchOpts(
  probeUpdatedAt: string | null,
  baseline: string | undefined,
): { maxAgeSecs?: number; force?: boolean } {
  if (!probeUpdatedAt || !baseline) return {};
  if (probeUpdatedAt === baseline) return { maxAgeSecs: BOARD_UNCHANGED_MAX_AGE_SECS };
  return { force: true };
}

/**
 * Run a heavy Projects-v2 `node(id)` query gated by the board's updatedAt probe (#2448): the
 * probe (itself TTL-cached) decides whether the heavy query may serve the backend's cached copy
 * past the default window (unchanged) or must POST fresh (moved).
 *
 * Baseline caveat: the heavy body recorded against the probe's updatedAt may be a TTL-cache copy
 * up to the default window older than the probe — bounded staleness we accept, since any real
 * change moves `updatedAt` again and forces a refresh.
 */
export async function fetchBoardWithProbe<T>(query: string, id: string): Promise<T> {
  let probeUpdatedAt: string | null = null;
  try {
    const d = await githubGraphql<{ node?: { updatedAt?: string } | null }>(BOARD_PROBE_QUERY, { id });
    probeUpdatedAt = d.node?.updatedAt ?? null;
  } catch {
    // Probe failed — run the heavy query exactly as before (default TTL); it serves the backend
    // cache or surfaces the real error itself.
  }
  const data = await githubGraphql<T>(query, { id }, boardFetchOpts(probeUpdatedAt, boardBaselines.get(id)));
  if (probeUpdatedAt) boardBaselines.set(id, probeUpdatedAt);
  return data;
}
