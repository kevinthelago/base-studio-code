// Heuristic worker auto-end decision (#1379). The authoritative `pty_exit` trigger (#920) is dead
// for stable-identity workers (#1176) and likely never fires anyway (claude returns to the bash
// prompt without the SHELL exiting). So drive auto-end heuristically off IDLE TIME, branched on
// whether the worker has an outstanding question — Claude-driven, not foolproof, by design.
//
// This is the pure brain: (idle state + outstanding-ask? + owned-issue completeness + thresholds)
// → one action. The side effects (inject the close-nudge, resurface the question, end the pane)
// live in the hook/store; keeping the decision pure makes every branch unit-testable.

import type { WorkerEndVerdict } from "./workerEnd";

/** What to do for an at-rest worker this tick. */
export type AutoEndAction =
  | "none"               // still working, or not idle long enough — do nothing
  | "close-nudge"        // idle + no question + work complete → nudge it to close itself
  | "resurface-question"; // idle past the lost-question wait with an unanswered ask → resurface it

export interface AutoEndSignals {
  /** Turn still open per the #1184 activity signal — the worker is actively working (never act). */
  turnOpen: boolean;
  /** How long the worker has been at rest, ms (now − last activity). */
  idleMs: number;
  /** An unanswered `bsc-ask` is outstanding for this worker (from the coordination log). */
  hasOutstandingQuestion: boolean;
  /** The owned-issue completeness verdict (classifyWorkerEnd) — only `done` warrants a close-nudge. */
  verdict: WorkerEndVerdict;
}

export interface AutoEndThresholds {
  /** Idle before nudging a question-free, complete worker to close — SHORTER. */
  closeNudgeMs: number;
  /** Idle before treating an unanswered question as lost and resurfacing it — LONGER. */
  lostQuestionMs: number;
}

/** Defaults: a question-free worker is nudged to close after 1 min idle; an unanswered question is
 *  given 5 min before it's treated as lost. Tunable; the longer window gives the director time. */
export const DEFAULT_AUTO_END_THRESHOLDS: AutoEndThresholds = {
  closeNudgeMs: 60_000,
  lostQuestionMs: 300_000,
};

/**
 * Decide what to do for an at-rest worker.
 *
 * - Turn still open → `none` (it's working, even if silent — never act).
 * - Outstanding question → only `resurface-question` once idle ≥ the LONGER `lostQuestionMs`
 *   (give the director time to answer); otherwise `none`. Never close a worker that's waiting.
 * - No question → `close-nudge` once idle ≥ the SHORTER `closeNudgeMs` AND the owned work is
 *   genuinely complete (`verdict.state === "done"`). A `needs-attention`/`blocked` worker is NOT
 *   nudged to close — that's the director's call.
 */
export function decideWorkerAutoEnd(s: AutoEndSignals, t: AutoEndThresholds): AutoEndAction {
  if (s.turnOpen) return "none";
  if (s.hasOutstandingQuestion) {
    return s.idleMs >= t.lostQuestionMs ? "resurface-question" : "none";
  }
  if (s.idleMs >= t.closeNudgeMs && s.verdict.state === "done") return "close-nudge";
  return "none";
}
