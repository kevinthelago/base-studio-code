// The workflow conductor (#220): the pure decision layer that drives a work item through
// its workflow. Given a stage's outcome it advances the state machine and says what to do
// next -- launch a fresh role-scoped session for the new stage (seeded with the prior
// stage's output), finish, or escalate to a human/director. The store/PTY layer that
// actually launches a stage session, and the wiring that turns a stage's #199 landed/
// failed event into an outcome, land on top of this. Kept pure so the orchestration logic
// is fully testable -- the conductor is a coordinator, never a doer.
import {
  type Workflow, type ItemState, type Outcome, type WorkflowRole,
  startItem, advance, stageCapability,
} from "./workflow";
import type { RoleCapability } from "./sessionRoles";

/** A workflow run: the workflow definition + the item's current state. */
export interface WorkflowRun {
  workflow: Workflow;
  state: ItemState;
}

/** What to launch next: a fresh role-scoped session for `stage`. */
export interface StageLaunch {
  item: string;
  stage: string;
  role: WorkflowRole;
  capability: RoleCapability;
  /** The prior stage's output, carried into the fresh session as context (e.g. a test
   *  failure log handed to the fix stage). Undefined for the first stage. */
  seed?: string;
}

export type ConductResult =
  | { kind: "launch"; run: WorkflowRun; launch: StageLaunch }
  | { kind: "done"; run: WorkflowRun }
  | { kind: "escalated"; run: WorkflowRun; reason: string };

function launchFor(p: Workflow, state: ItemState, seed?: string): StageLaunch {
  const stage = p.stages[state.stage as string];
  return { item: state.item, stage: stage.name, role: stage.role, capability: stageCapability(stage), seed };
}

/** Start a run: the item enters its first stage, which is launched immediately. */
export function startRun(workflow: Workflow, item: string): { run: WorkflowRun; launch: StageLaunch } {
  const state = startItem(workflow, item);
  return { run: { workflow, state }, launch: launchFor(workflow, state) };
}

/**
 * Advance a run by the current stage's `outcome`, carrying `seed` (the stage's output)
 * into the next stage. Returns what to do next: launch the next stage's session, finish,
 * or escalate.
 */
export function conduct(run: WorkflowRun, outcome: Outcome, seed?: string): ConductResult {
  const state = advance(run.workflow, run.state, outcome);
  const next: WorkflowRun = { workflow: run.workflow, state };
  if (state.status === "done") return { kind: "done", run: next };
  if (state.status === "escalated") return { kind: "escalated", run: next, reason: state.escalation ?? "escalated" };
  return { kind: "launch", run: next, launch: launchFor(run.workflow, state, seed) };
}

/** The launch for a run's CURRENT stage (null when terminal). Used to (re)mount the run's
 *  pane for the stage it is now in — both the initial stage and after each advance. */
export function currentLaunch(run: WorkflowRun, seed?: string): StageLaunch | null {
  if (run.state.status !== "active" || run.state.stage === null) return null;
  return launchFor(run.workflow, run.state, seed);
}
