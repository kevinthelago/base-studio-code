// Resolving a fleet's issue states WITHOUT a React render (#4103).
//
// #4102 put the GitHub overlay behind `useFleetIssueState`, a hook — which is right for the graph, and
// useless to the three places that decide whether a worker is FINISHED: the progress-gated relaunch
// (`resumeProjectFleet`), the dependency gate (`useFleetHeld`) and the publish-time prune
// (`usePlanPublish`). Those run in async callbacks, not renders.
//
// So the fetch lives here as a plain async function and the hook sits on top of it. One query builder,
// one parse, two entry points — a second copy would be the thing that eventually disagrees about
// whether an issue is closed.
import { githubGraphql } from "@/shared/lib/github/github";
import { groupRefsByRepo, buildIssueStateQuery, parseIssueStates } from "./issueStateQuery";
import { normalizeRef } from "./fleetPlanProgress";

/** Same window the hook uses — served from the backend's ETag cache, so the gate and the graph do not
 *  each spend a call. */
const MAX_AGE_SECS = 120;

/** A stream as this needs it — structural, so a caller does not have to hand over a whole `AgentStream`. */
export interface RefBearingStream {
  repo?: string;
  issues?: readonly string[];
}

/**
 * The refs GitHub reports CLOSED, returned in each stream's OWN ref spelling.
 *
 * That spelling is the whole point. `streamComplete` asks `stream.issues.every((r) => done.has(r))`,
 * and a stream stores `"#3898"` while the GitHub response carries the number `3898`. A set of
 * normalized refs would therefore match NOTHING and every stream would read as unfinished — the exact
 * silent failure #4103 is about, reintroduced from the other side. Emitting the original strings makes
 * the formats agree by construction rather than by convention.
 *
 * Returns an EMPTY set on any failure (no token, offline, a GraphQL error). That is deliberate and
 * matches the pre-existing rule these gates already follow: absent evidence must under-report
 * completion, never over-report it. Claiming a stream finished because a fetch failed would skip a
 * worker that still has work.
 */
export async function resolveClosedRefs(
  streams: readonly RefBearingStream[],
): Promise<Set<string>> {
  const out = new Set<string>();
  const query = buildIssueStateQuery(groupRefsByRepo(streams));
  if (!query) return out;                    // nothing addressable ⇒ no request at all
  try {
    const states = parseIssueStates(await githubGraphql<unknown>(query, null, { maxAgeSecs: MAX_AGE_SECS }));
    for (const s of streams) {
      for (const ref of s.issues ?? []) {
        if (states.get(normalizeRef(ref)) === true) out.add(ref);
      }
    }
  } catch {
    return new Set();                        // fail CLOSED — under-report, never over-report
  }
  return out;
}
