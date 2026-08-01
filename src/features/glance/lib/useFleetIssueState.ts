// The drilled fleet's issue states, overlaid from GitHub (#4102).
//
// Scoped to the DRILLED project and batched into ONE query per repo (see `issueStateQuery.ts`), so the
// cost is bounded by what the user is actually looking at and stops entirely when they leave the drill
// — the same discipline `useStreamProgress` documents.
//
// ── LOCAL-FIRST, NEVER TOKEN-GATED (#2444) ──────────────────────────────────────────────────────
// With no token this returns an empty map and NOTHING breaks: issue OWNERSHIP comes from the fleet
// plan, so the plan screen still lists every worker's issues and the progress bar simply shows no
// completions yet. The overlay adds state; it is never the reason the list is empty.
import { useMemo } from "react";
import { githubGraphql } from "@/shared/lib/github/github";
import { useGithubQuery } from "@/shared/lib/github/useGithubQuery";
import { groupRefsByRepo, buildIssueStateQuery, parseIssueStates, closedRefs } from "./issueStateQuery";

/** Issue open/closed moves at human speed — a worker closing one is a minutes-scale event. Served from
 *  the backend's ETag cache within this window, so a re-drill costs no network call at all. */
const MAX_AGE_SECS = 120;

export interface FleetIssueState {
  /** ref (unprefixed, e.g. `3898`) → closed. Empty while loading, without a token, or on error. */
  states: Map<string, boolean>;
  /** Just the closed refs — what `fleetPlanProgress` consumes. */
  done: Set<string>;
  loading: boolean;
  /** Set when the overlay could not be fetched. The caller still renders the list; this only explains
   *  absent state chips, so a disconnected user is told why rather than shown a silent zero. */
  error: string | null;
}

/**
 * Resolve open/closed for every issue ref owned by `streams`.
 *
 * `streams` should be the drilled project's fleet (or empty when not drilled — then nothing is fetched).
 */
export function useFleetIssueState(
  streams: readonly { repo?: string; issues?: readonly string[] }[],
): FleetIssueState {
  // The query is derived, not stored, and keyed by its own text: two renders yielding the same refs
  // produce the same string, so `useGithubQuery` does not refetch on every parent re-render.
  const query = useMemo(() => buildIssueStateQuery(groupRefsByRepo(streams)), [streams]);

  const { data, loading, error } = useGithubQuery<unknown>(
    () => githubGraphql<unknown>(query!, null, { maxAgeSecs: MAX_AGE_SECS }),
    [query],
    // A fleet with no addressable refs must not spend a request — nor show a spinner for an answer
    // that would be empty either way.
    !!query,
  );

  return useMemo(() => {
    const states = parseIssueStates(data);
    return { states, done: closedRefs(states), loading, error };
  }, [data, loading, error]);
}
