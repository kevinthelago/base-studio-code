// Worker completeness classifier (#920). When a fleet worker's PTY exits, we decide its
// resting state from plan.db OWNED-ISSUE STATUS — the structured, per-issue, recovery-durable
// source of truth — NOT the worker's free-text "I'm done". coord.log landed/merged is a
// tiebreaker that surfaces the "marked complete but the PR never merged" gap, but does not
// block the card: a worker's card closes on worker-finished (`complete`), while `verified` /
// merged is the director's separate confirmation, surfaced in the summary.

import { isSatisfied, parseRef, type CoordState } from "./coordination";
import type { WorkerEndState } from "@/store/types";

/** One owned issue's ref + plan.db lifecycle status. */
export interface OwnedIssue {
  ref: string;
  /** open | in_progress | blocked | complete | verified | failed */
  status: string;
  /** Owning fleet stream id (#3944). Present on `bsc plan list --full` rows; lets a caller read a
   *  project's issues ONCE and partition by stream in memory instead of querying per stream. */
  stream?: string;
}

export interface WorkerEndVerdict {
  state: WorkerEndState;
  summary: string;
}

// plan.db issue lifecycle buckets (crates/plandb STATUSES).
/** The worker did its part. EXPORTED (#4050) so the progress bar counts "done" the same way the
 *  finished-verdict does — a second definition would eventually disagree with the card that says
 *  "finished", and the two would drift silently. */
export const TERMINAL_GOOD = new Set(["complete", "verified"]); // the worker did its part
const STILL_RUNNING = new Set(["open", "in_progress"]);   // stopped early
const TERMINAL_BAD = new Set(["blocked", "failed"]);      // needs attention

/**
 * Classify a finished worker from its owned issues + the coordination state.
 *
 * Precedence: any blocked/failed ⇒ `blocked`; else any still-open ⇒ `needs-attention`
 * (stopped early — never silently "done"); else all complete/verified ⇒ `done`. An empty
 * owned-issue set is `needs-attention` (we can't confirm completion from the DB).
 *
 * The `landed` count (coord.log merged/landed/closed for the owned refs) is reported in the
 * summary so "worker finished" reads distinctly from "work shipped".
 */
export function classifyWorkerEnd(issues: OwnedIssue[], coord: CoordState): WorkerEndVerdict {
  if (issues.length === 0) {
    return { state: "needs-attention", summary: "no owned issues in plan.db — can't confirm completion" };
  }

  let good = 0, running = 0, bad = 0;
  for (const i of issues) {
    if (TERMINAL_BAD.has(i.status)) bad++;
    else if (STILL_RUNNING.has(i.status)) running++;
    else if (TERMINAL_GOOD.has(i.status)) good++;
    else running++; // unknown status ⇒ treat as not-done (conservative)
  }

  const landed = issues.filter((i) => {
    const ref = parseRef(i.ref);
    return ref ? isSatisfied(coord, ref) : false;
  }).length;

  const n = issues.length;
  if (bad > 0) {
    return { state: "blocked", summary: `${bad}/${n} blocked or failed · ${good}/${n} complete` };
  }
  if (running > 0) {
    return { state: "needs-attention", summary: `stopped early — ${running}/${n} still open · ${good}/${n} complete` };
  }
  return { state: "done", summary: `${n}/${n} complete · ${landed}/${n} landed` };
}
