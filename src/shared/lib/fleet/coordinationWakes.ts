// -- Wake planning + inbox view (#199 slice 3) ----------------------------------
// Pure "decide + present": given the ingested latch state, what to wake (with what
// prompt) and what the inbox/health view shows. The store/PTY execution (relaunch the
// pane, render the panel) is a thin layer on top of these in a later slice.
import type {
  CoordRef,
  Waiter,
  CoordState,
  AssignedWork,
  AnsweredWake,
  WaitingSession,
  WakeAction,
  BlockedView,
  ProducerOf,
} from "./coordination.types";
import { refKey } from "./coordinationState";
import { detectDeadlocks, defaultProducerOf } from "./coordinationDeadlock";

/** A ref's latch status as a short label (for prompts + the inbox view). */
function statusOf(s: CoordState, ref: CoordRef): "satisfied" | "failed" | "pending" {
  const l = s.latches[refKey(ref)];
  return l?.state === "satisfied" ? "satisfied" : l?.state === "failed" ? "failed" : "pending";
}

/**
 * Compose the token-aware wake prompt for a woken waiter -- names the landed deps (with
 * how they were satisfied) and points at the checkpoint, so the FRESH session resumes
 * without re-deriving context (never `--continue` on a fat transcript; see #199).
 */
export function wakePromptFor(w: Waiter, s: CoordState): string {
  const landed = w.deps
    .map((d) => {
      const l = s.latches[refKey(d)];
      const via = l?.state === "satisfied" ? l.source : "ready";
      return `${refKey(d)} (${via})`;
    })
    .join(", ");
  const lines = [
    `Your blocking ${w.deps.length === 1 ? "dependency has" : "dependencies have"} landed -- resume now.`,
    `Satisfied: ${landed}.`,
  ];
  if (w.checkpoint) {
    lines.push(`Resume from your checkpoint: ${w.checkpoint} -- read it first, then continue from where you left off.`);
  }
  return lines.join("\n");
}

/**
 * Compose the wake prompt for a session that paused for the USER (#297 checkpoint/
 * confirm flow) — names the reason it paused and points at the checkpoint so the
 * fresh session resumes in context. Unlike {@link wakePromptFor}, there are no deps
 * to report; the user has decided to resume it.
 */
export function waitingWakePrompt(w: WaitingSession): string {
  const lines = [
    w.reason.trim()
      ? `You paused for confirmation: ${w.reason.trim()} — the user has resumed you; proceed.`
      : "You paused for the user — you have been resumed; proceed.",
  ];
  if (w.checkpoint) {
    lines.push(`Resume from your checkpoint: ${w.checkpoint} — read it first, then continue from where you left off.`);
  }
  return lines.join("\n");
}

/**
 * Compose the wake prompt for a session the DIRECTOR answered (#369). Carries the
 * director's answer and points at the checkpoint, so the fresh session resumes on that
 * basis without re-asking. This is what makes "defer to the director" a real round-trip.
 */
export function answerWakePrompt(a: AnsweredWake): string {
  const lines = [
    `The director responded: ${a.answer.trim() || "(see the director's notes)"} — proceed on that basis; you are no longer parked. Do not ask the user.`,
  ];
  if (a.checkpoint) {
    lines.push(`Resume from your checkpoint: ${a.checkpoint} — read it first, then continue.`);
  }
  return lines.join("\n");
}

/**
 * Compose the injection prompt for a worker the director assigned new work (#376).
 * States it is new work routed by the director, carries the title + body, and points
 * at the checkpoint so a resumed worker re-grounds before starting. The worker then
 * flows into its normal implement → integrate loop.
 */
export function assignWakePrompt(a: AssignedWork): string {
  const lines = [
    `The director assigned you new work${a.title ? `: ${a.title}` : ""}. Start on it now and carry it through your normal loop (implement → gate → integrate). Do not ask the user.`,
  ];
  if (a.body.trim()) lines.push("", a.body.trim());
  if (a.checkpoint) {
    lines.push("", `First re-read your checkpoint: ${a.checkpoint}, then begin the new work.`);
  }
  return lines.join("\n");
}

/** Map newly-woken waiters to wake actions (the prompt-injection payloads slice 4 runs). */
export function planWakes(woken: Waiter[], s: CoordState): WakeAction[] {
  return woken.map((w) => ({ session: w.session, deps: w.deps, prompt: wakePromptFor(w, s) }));
}

/** Derive the inbox/health view from latch state: every still-parked waiter, each dep's
 *  status, whether the chain is stalled (a failed dep), and whether it sits in a wait-for
 *  cycle (a deadlock). `producerOf` resolves which session satisfies a dep (defaults to
 *  the `session:` self-resolver -- see {@link detectDeadlocks}). */
export function coordinationSummary(s: CoordState, producerOf: ProducerOf = defaultProducerOf): BlockedView[] {
  const deadlocked = new Set(detectDeadlocks(s, producerOf).flatMap((d) => d.cycle));
  return s.waiters.map((w) => {
    const deps = w.deps.map((d) => ({ ref: refKey(d), status: statusOf(s, d) }));
    return {
      session: w.session,
      checkpoint: w.checkpoint,
      deps,
      stalled: deps.some((d) => d.status === "failed"),
      deadlocked: deadlocked.has(w.session),
    };
  });
}

// -- Auto-wake recency gate (#199) ----------------------------------------------
// The always-on coordinator only auto-relaunches a ready session if its deps landed
// RECENTLY, so an app restart (which replays the whole log) can't relaunch sessions whose
// dependencies were satisfied long ago and were never woken. The manual Wake button has
// no such limit. Kept pure (takes `now`) so it's testable.

/** Newest moment among a waiter's deps at which one became satisfied (ms epoch), or 0. */
export function readinessAt(w: Waiter, s: CoordState): number {
  let newest = 0;
  for (const d of w.deps) {
    const l = s.latches[refKey(d)];
    if (l?.state === "satisfied" && l.at > newest) newest = l.at;
  }
  return newest;
}

/** Whether `w` became ready within `windowMs` of `now`. */
export function isFreshlyReady(w: Waiter, s: CoordState, now: number, windowMs: number): boolean {
  const at = readinessAt(w, s);
  return at > 0 && now - at < windowMs;
}
