// Session pipelines (#220): the pure stage state machine that chains role-scoped sessions
// through a work item's lifecycle (implement -> build&test -> review -> integrate) with
// bounded failure loops. The conductor advances an item by a stage outcome; the transport
// that parks/wakes a session between stages is #199. This module is pure (no PTY/store) so
// it's exhaustively testable; the conductor wiring lands on top of it in a later slice.
import type { SessionRole } from "./sessionRoles";

/** The role a stage runs as -- #219 roles plus the pipeline-specific ones (#220). Wiring
 *  tester/reviewer/conductor into #219's capability matrix is a later slice. */
export type PipelineRole = SessionRole | "tester" | "reviewer" | "conductor";

/** A transition target: another stage's name, or one of these terminals. */
export const DONE = "done";
export const ESCALATE = "escalate";
export type Transition = string;

export interface PipelineStage {
  name: string;
  role: PipelineRole;
  /** Where to go when the stage succeeds (a stage name, or DONE/ESCALATE). */
  onSuccess: Transition;
  /** Where to go when it fails. */
  onFailure: Transition;
  /** Max times this stage may be ENTERED before a failure loop escalates (bounds loops). */
  retryLimit: number;
}

export interface Pipeline {
  name: string;
  start: string;
  stages: Record<string, PipelineStage>;
}

export type ItemStatus = "active" | "done" | "escalated";
export type Outcome = "success" | "failure";

export interface ItemState {
  /** The work item (e.g. an issue ref / FeatureContract id). */
  item: string;
  /** Current stage name, or null when terminal (done/escalated). */
  stage: string | null;
  status: ItemStatus;
  /** Times each stage has been entered (bounds the loops). */
  attempts: Record<string, number>;
  history: { stage: string; outcome: Outcome }[];
  /** Why it escalated, when status is "escalated". */
  escalation?: string;
}

/** Begin an item at the pipeline's start stage. */
export function startItem(p: Pipeline, item: string): ItemState {
  return { item, stage: p.start, status: "active", attempts: { [p.start]: 1 }, history: [] };
}

function escalate(st: ItemState, history: ItemState["history"], why: string): ItemState {
  return { ...st, stage: null, status: "escalated", escalation: why, history };
}

/**
 * Advance an item by the current stage's `outcome`. Moves to the stage's onSuccess /
 * onFailure target, finishes (DONE), or escalates -- either because a transition says so,
 * or because entering the target would exceed its retryLimit (this is what bounds the
 * test<->fix loop). Terminal states are returned unchanged (idempotent).
 */
export function advance(p: Pipeline, st: ItemState, outcome: Outcome): ItemState {
  if (st.status !== "active" || st.stage === null) return st;
  const stage = p.stages[st.stage];
  const history = [...st.history, { stage: st.stage, outcome }];
  if (!stage) return escalate(st, history, `unknown stage '${st.stage}'`);

  const target = outcome === "success" ? stage.onSuccess : stage.onFailure;
  if (target === DONE) return { ...st, stage: null, status: "done", history };
  if (target === ESCALATE) return escalate(st, history, `${stage.name} ${outcome}`);

  const next = p.stages[target];
  if (!next) return escalate(st, history, `unknown target '${target}'`);

  const n = (st.attempts[target] ?? 0) + 1;
  if (n > next.retryLimit) {
    return escalate(st, history, `${target} exceeded retryLimit (${next.retryLimit})`);
  }
  return { ...st, stage: target, status: "active", attempts: { ...st.attempts, [target]: n }, history };
}

// -- Presets (start linear + the test-fail loop) --------------------------------

export const PIPELINE_PRESETS: Record<string, Pipeline> = {
  "implement-test-review-integrate": {
    name: "implement -> test -> review -> integrate",
    start: "implement",
    stages: {
      implement:    { name: "implement",  role: "worker",   onSuccess: "build-test", onFailure: ESCALATE,    retryLimit: 3 },
      "build-test": { name: "build-test", role: "tester",   onSuccess: "review",     onFailure: "fix",       retryLimit: 3 },
      fix:          { name: "fix",        role: "worker",   onSuccess: "build-test", onFailure: ESCALATE,    retryLimit: 3 },
      review:       { name: "review",     role: "reviewer", onSuccess: "integrate",  onFailure: "implement", retryLimit: 2 },
      integrate:    { name: "integrate",  role: "director", onSuccess: DONE,         onFailure: ESCALATE,    retryLimit: 1 },
    },
  },
  "spike-implement-test": {
    name: "spike -> implement -> test",
    start: "spike",
    stages: {
      spike:        { name: "spike",      role: "worker",   onSuccess: "implement",  onFailure: ESCALATE,    retryLimit: 1 },
      implement:    { name: "implement",  role: "worker",   onSuccess: "build-test", onFailure: ESCALATE,    retryLimit: 3 },
      "build-test": { name: "build-test", role: "tester",   onSuccess: DONE,         onFailure: "implement", retryLimit: 3 },
    },
  },
  "research-plan-implement-test": {
    name: "research -> plan -> implement -> test",
    start: "research",
    stages: {
      research:     { name: "research",   role: "worker",   onSuccess: "plan",       onFailure: ESCALATE,    retryLimit: 1 },
      plan:         { name: "plan",       role: "planner",  onSuccess: "implement",  onFailure: ESCALATE,    retryLimit: 1 },
      implement:    { name: "implement",  role: "worker",   onSuccess: "build-test", onFailure: ESCALATE,    retryLimit: 3 },
      "build-test": { name: "build-test", role: "tester",   onSuccess: DONE,         onFailure: "implement", retryLimit: 3 },
    },
  },
};
