// Session workflows (#220): the pure stage state machine that chains role-scoped sessions
// through a work item's lifecycle (implement -> build&test -> review -> integrate) with
// bounded failure loops. The conductor advances an item by a stage outcome; the transport
// that parks/wakes a session between stages is #199. This module is pure (no PTY/store) so
// it's exhaustively testable; the conductor wiring lands on top of it in a later slice.
import { type SessionRole, type RoleCapability, roleCapability } from "../session/sessionRoles";
import workflowPresetsEmbedded from "@data/fleet/workflow-presets.json";
import { overlayFile } from "@/shared/lib/core/configOverrides";

/** The role a stage runs as. The #220 stage roles (tester/reviewer/conductor) now live
 *  in #219's SessionRole + capability matrix, so a stage maps straight to a capability. */
export type WorkflowRole = SessionRole;

/** A transition target: another stage's name, or one of these terminals. */
export const DONE = "done";
export const ESCALATE = "escalate";
export type Transition = string;

export interface WorkflowStage {
  name: string;
  role: WorkflowRole;
  /** Where to go when the stage succeeds (a stage name, or DONE/ESCALATE). */
  onSuccess: Transition;
  /** Where to go when it fails. */
  onFailure: Transition;
  /** Max times this stage may be ENTERED before a failure loop escalates (bounds loops). */
  retryLimit: number;
}

export interface Workflow {
  name: string;
  start: string;
  stages: Record<string, WorkflowStage>;
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

/** Begin an item at the workflow's start stage. */
export function startItem(p: Workflow, item: string): ItemState {
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
export function advance(p: Workflow, st: ItemState, outcome: Outcome): ItemState {
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

/** The #219 capability a stage runs under (least-privilege per role) -- this is how a
 *  workflow stage composes with the role gate: the conductor launches each stage in a
 *  session scoped to `stageCapability(stage)`. */
export function stageCapability(stage: WorkflowStage): RoleCapability {
  return roleCapability(stage.role);
}

// -- Presets (start linear + the test-fail loop) --------------------------------
//
// The preset DATA is externalized to `@data/fleet/workflow-presets.json` (#2146, epic #2027 tail) —
// editable without touching code + part of the exportable config bundle; the config-dir copy (#2047)
// overlays the embedded default via `overlayFile`. This module keeps the TYPES + the state machine
// (`advance`/`startItem`). The JSON uses the DONE/ESCALATE terminal literals ("done"/"escalate")
// verbatim.
export const WORKFLOW_PRESETS: Record<string, Workflow> =
  overlayFile("fleet/workflow-presets.json", workflowPresetsEmbedded as Record<string, Workflow>);
