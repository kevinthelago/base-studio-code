// The pipeline conductor (#220): the pure decision layer that drives a work item through
// its pipeline. Given a stage's outcome it advances the state machine and says what to do
// next -- launch a fresh role-scoped session for the new stage (seeded with the prior
// stage's output), finish, or escalate to a human/director. The store/PTY layer that
// actually launches a stage session, and the wiring that turns a stage's #199 landed/
// failed event into an outcome, land on top of this. Kept pure so the orchestration logic
// is fully testable -- the conductor is a coordinator, never a doer.
import {
  type Pipeline, type ItemState, type Outcome, type PipelineRole,
  startItem, advance, stageCapability,
} from "./pipeline";
import type { RoleCapability } from "./sessionRoles";

/** A pipeline run: the pipeline definition + the item's current state. */
export interface PipelineRun {
  pipeline: Pipeline;
  state: ItemState;
}

/** What to launch next: a fresh role-scoped session for `stage`. */
export interface StageLaunch {
  item: string;
  stage: string;
  role: PipelineRole;
  capability: RoleCapability;
  /** The prior stage's output, carried into the fresh session as context (e.g. a test
   *  failure log handed to the fix stage). Undefined for the first stage. */
  seed?: string;
}

export type ConductResult =
  | { kind: "launch"; run: PipelineRun; launch: StageLaunch }
  | { kind: "done"; run: PipelineRun }
  | { kind: "escalated"; run: PipelineRun; reason: string };

function launchFor(p: Pipeline, state: ItemState, seed?: string): StageLaunch {
  const stage = p.stages[state.stage as string];
  return { item: state.item, stage: stage.name, role: stage.role, capability: stageCapability(stage), seed };
}

/** Start a run: the item enters its first stage, which is launched immediately. */
export function startRun(pipeline: Pipeline, item: string): { run: PipelineRun; launch: StageLaunch } {
  const state = startItem(pipeline, item);
  return { run: { pipeline, state }, launch: launchFor(pipeline, state) };
}

/**
 * Advance a run by the current stage's `outcome`, carrying `seed` (the stage's output)
 * into the next stage. Returns what to do next: launch the next stage's session, finish,
 * or escalate.
 */
export function conduct(run: PipelineRun, outcome: Outcome, seed?: string): ConductResult {
  const state = advance(run.pipeline, run.state, outcome);
  const next: PipelineRun = { pipeline: run.pipeline, state };
  if (state.status === "done") return { kind: "done", run: next };
  if (state.status === "escalated") return { kind: "escalated", run: next, reason: state.escalation ?? "escalated" };
  return { kind: "launch", run: next, launch: launchFor(run.pipeline, state, seed) };
}
