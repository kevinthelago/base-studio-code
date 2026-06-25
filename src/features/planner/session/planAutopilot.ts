// Planning autopilot (#682, Phase 1) — the PURE decision core that drives a planning
// session to a complete plan with a SIMULATED user. The live runner (PTY + Claude + store
// actions) wires these into the real session; this module is React/Tauri-free and fully
// unit-testable.
//
// The planning loop has three actors: the planner (Claude, autonomous), the user (simulated
// here), and the app (confirms sections, advances, publishes). The driver decides, each
// tick, what the user/app should do next given the planning state.

import type { Phase } from "../stages/focusedPlan";

/** How the simulated user answers the planner. Phase 1 wires `llm`; the rest are Phase 2. */
export type AutopilotStrategy = "llm" | "scripted" | "random" | "none";

/** The next thing the driver should do. */
export type AutopilotAction =
  | { kind: "publish" }                  // the plan is complete → publish (MOCKED in the harness)
  | { kind: "done" }                     // finished (already published / nothing left)
  | { kind: "confirm"; keys: string[] }  // confirm the active stage's sections → advances its gate
  | { kind: "reply" }                    // planner is awaiting input → send a simulated-user reply
  | { kind: "wait" }                     // planner is still working → poll again next tick
  | { kind: "stall"; reason: string };   // no progress / cap hit → stop

/** Everything the driver needs to decide, computed by the runner from the live plan state. */
export interface AutopilotContext {
  /** Whole plan is publishable (planSectionsComplete over the blueprint). */
  planReady: boolean;
  /** Whether publish has already fired (so we don't loop on it). */
  published: boolean;
  /** The active stage's confirmable section keys, NON-EMPTY only when the stage has produced
   *  enough to confirm (its required content exists). Empty ⇒ the stage still needs work. */
  confirmKeys: string[];
  /** The planner finished its turn and is waiting for input (idle-detected by the runner). */
  plannerAwaiting: boolean;
  /** Tick counter + hard cap — the ultimate runaway guard. */
  iteration: number;
  maxIterations: number;
  /** Consecutive ticks with no forward progress while idle — the stall guard. */
  idleStreak: number;
  maxIdle: number;
  /** Whether to (mock-)publish on completion. The Settings FEATURE stops at a publishable
   *  plan for review (false); the dev harness mock-publishes (true). (#682) */
  autoPublish: boolean;
}

/**
 * Decide the next autopilot action from the current planning state. Priority:
 * cap → publish/done → (while the planner waits) confirm-if-ready else reply → stall-if-stuck
 * → wait. Pure + deterministic.
 */
export function decideAutopilotAction(ctx: AutopilotContext): AutopilotAction {
  if (ctx.iteration >= ctx.maxIterations) {
    return { kind: "stall", reason: `hit the ${ctx.maxIterations}-iteration cap` };
  }
  if (ctx.planReady) {
    if (!ctx.autoPublish) return { kind: "done" }; // feature: stop at a publishable plan for review
    return ctx.published ? { kind: "done" } : { kind: "publish" };
  }
  // Stall on no forward progress — checked BEFORE the await branch so a non-responding user
  // (the `none` strategy) stalls instead of replying-with-nothing forever (#682, Phase 2).
  if (ctx.idleStreak >= ctx.maxIdle) {
    return { kind: "stall", reason: `no progress for ${ctx.idleStreak} ticks` };
  }
  if (ctx.plannerAwaiting) {
    // Stage has its required content → confirm it (which advances the gate). Otherwise the
    // planner's turn is done but the stage isn't ready, so answer its questions to continue.
    return ctx.confirmKeys.length > 0 ? { kind: "confirm", keys: ctx.confirmKeys } : { kind: "reply" };
  }
  return { kind: "wait" };
}

/**
 * The system + user prompt for the simulated-user (`llm` strategy): a product owner being
 * interviewed by the planner. Decisive, concrete, consistent with the pitch, no questions back.
 */
export function buildUserSimPrompt(pitch: string, plannerOutput: string): { system: string; user: string } {
  const system =
    "You are simulating a PRODUCT OWNER being interviewed by an AI project planner. " +
    "Answer the planner's latest message concretely and decisively in 1–3 sentences, as the " +
    "person who pitched the project. Make reasonable, consistent decisions; never ask " +
    "questions back; don't hedge or stall. When asked to choose or confirm, do so. Stay true " +
    "to the pitch and to your earlier answers.";
  const user =
    `PROJECT PITCH:\n${pitch.trim()}\n\n` +
    `THE PLANNER JUST SAID:\n${plannerOutput.trim()}\n\n` +
    `Your reply, as the product owner:`;
  return { system, user };
}

/** Canned fuzz replies for the `random` strategy (Phase 2) — deliberately noisy/terse. */
const RANDOM_REPLIES = [
  "sure, whatever you think is best",
  "yes", "no", "skip that one", "use the defaults",
  "I'm not sure, you decide", "keep it simple", "next",
];

/**
 * A non-LLM simulated-user reply (Phase 2 strategies). `none` sends nothing (stall test);
 * `random` returns canned fuzz; `scripted` is a generic affirmative; `llm` is handled async
 * by the runner via {@link buildUserSimPrompt} and returns null here.
 */
export function staticReply(strategy: AutopilotStrategy, seed: number): string | null {
  switch (strategy) {
    case "none": return null;
    case "random": return RANDOM_REPLIES[Math.abs(Math.trunc(seed)) % RANDOM_REPLIES.length];
    case "scripted": return "Looks good — proceed.";
    case "llm": return null;
  }
}

/** Progress fraction (0..1) over the visible phases — how far the plan got. */
export function autopilotProgress(phases: Phase[]): { done: number; total: number; fraction: number } {
  const total = phases.length;
  const done = phases.filter((p) => p.status === "complete" || p.status === "ahead").length;
  return { done, total, fraction: total ? done / total : 0 };
}

/** Outcome of an autopilot run — what the runner reports + the transcript inspector shows. */
export interface AutopilotResult {
  completed: boolean;
  published: boolean;
  iterations: number;
  progress: { done: number; total: number; fraction: number };
  stalledReason?: string;
}
