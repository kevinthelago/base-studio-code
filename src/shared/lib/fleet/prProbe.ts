// When to ask GitHub about a finished worker's PR again — and when to stop asking.
//
// ## The bug this replaces
//
// `useWorkerAutoEnd` reclaims a worker's worktree once its PR is merged. Its retry state was recorded
// ONLY on the success path (`tornDownRef.add(paneId)` after a merge), so a pane whose branch was never
// merged — or that never had a PR at all — was re-queried every 60 seconds for the life of the app.
//
// MEASURED on a real install: 31 ended panes, all `role: worker`, producing a dead-steady 30
// `github_request` invokes per minute in one burst — 935 in a single app log. That is ~1800 API calls
// an hour, roughly a third of the authenticated rate budget, spent re-asking a question whose answer
// had not changed.
//
// ## Why a verdict, not a boolean
//
// "Not merged" hides three different futures, and they deserve different treatment:
//
//   * `merged` — done. Tear the worktree down and never ask again.
//   * `open`   — a PR exists and is unmerged. This one CAN still change, so it is the only verdict
//                worth re-asking — but on a backoff, because a PR that has been open for an hour is
//                not about to become urgent.
//   * `none`   — no PR exists for that branch. Nothing is in flight to change. Someone could open one
//                later, so a few attempts are worth it, but polling forever is how the 30/min happened.
//   * `unknown`— the request failed (offline, 401, rate-limited). That is not an ANSWER, so it must
//                not consume an attempt; otherwise a spell of bad network would permanently retire a
//                pane whose PR later merges.

/** What GitHub said about a worker branch's pull request. */
export type PrVerdict = "merged" | "open" | "none" | "unknown";

/** First retry delay for a verdict that is worth re-asking. Matches the poll cadence it replaces. */
export const PROBE_BASE_MS = 60_000;
/** Ceiling on the backoff. Half an hour is far below "forever" and far above "every minute". */
export const PROBE_MAX_MS = 30 * 60_000;
/** How many times to re-ask when NO pull request exists. Enough to cover "the PR is opened shortly
 *  after the worker finishes", which is the normal flow; not enough to poll for a day. */
export const NO_PR_ATTEMPTS = 5;

export interface ProbePlan {
  /** Wait this long before asking again, or `null` to stop asking permanently. */
  retryInMs: number | null;
  /** Whether this verdict consumed an attempt. A failed REQUEST is not an answer and must not. */
  countsAsAttempt: boolean;
}

/**
 * Classify a `repos/:repo/pulls?head=…` response into a verdict.
 *
 * `null`/non-array is `unknown` — `safeInvoke` returns the fallback on failure, and treating a failed
 * request as "no PR" is what would retire a pane for being briefly offline.
 */
export function verdictFromPulls(prs: unknown): PrVerdict {
  if (!Array.isArray(prs)) return "unknown";
  if (prs.length === 0) return "none";
  const first = prs[0] as { merged_at?: string | null } | undefined;
  return first?.merged_at ? "merged" : "open";
}

/**
 * When to ask again, given the verdict and how many answers this pane has already produced.
 *
 * `attempts` counts ANSWERS, not requests — see `countsAsAttempt`.
 */
export function planNextProbe(verdict: PrVerdict, attempts: number): ProbePlan {
  switch (verdict) {
    case "merged":
      // The terminal state. The caller tears down; there is nothing left to learn.
      return { retryInMs: null, countsAsAttempt: true };
    case "open":
      // Exponential from the old fixed cadence, capped. `attempts` is the count BEFORE this answer, so
      // the first backoff is one interval — the same wait the old code used, then progressively less.
      return {
        retryInMs: Math.min(PROBE_BASE_MS * 2 ** attempts, PROBE_MAX_MS),
        countsAsAttempt: true,
      };
    case "none":
      return {
        retryInMs: attempts + 1 >= NO_PR_ATTEMPTS ? null : Math.min(PROBE_BASE_MS * 2 ** attempts, PROBE_MAX_MS),
        countsAsAttempt: true,
      };
    case "unknown":
      // Retry at the base cadence WITHOUT consuming an attempt: a failed request says nothing about
      // the PR, and letting it count would let an outage permanently retire a pane.
      return { retryInMs: PROBE_BASE_MS, countsAsAttempt: false };
  }
}

/** Is this pane due to be asked about at `now`? A pane with no record yet is always due. */
export function isDue(nextAt: number | undefined, now: number): boolean {
  return nextAt === undefined || now >= nextAt;
}
