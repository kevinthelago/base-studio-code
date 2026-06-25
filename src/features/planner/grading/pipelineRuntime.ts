// Stage-run types for the in-app stage helpers (render-preview, grade-plan, lint-plan).
//
// The generic "pipeline engine" (handler registry + runner + trigger dispatch + gate
// predicate) was removed in #897 Phase 4c — there was never a production trigger pump,
// and the three remaining behaviors run by DIRECT dispatch (see their modules). What's
// left here is just the shared run-state shapes those dispatches + the store use.
// (Distinct from #220's fleet conductor, now named "workflow" — its runs are `workflowRuns`.)

/** What a stage helper receives: the stage's identity + its read-only artifacts. */
export interface StageContext {
  projectKey: string;
  stageId: string;
  /** Stage artifacts as relpath → contents (read-only). */
  artifacts: Readonly<Record<string, string>>;
  /** The artifact a focused run targets (e.g. the screen for render-preview). */
  entry?: string;
  /** Free-form mode the handler reads (render-preview uses "2d" | "3d"). */
  mode?: string;
}

export type PipelineOutcome = "ok" | "fail" | "blocked";
export type PipelineStatus = "idle" | "running" | PipelineOutcome;

export interface PipelineRunResult {
  status: PipelineOutcome;
  message?: string;
  /** Handler-specific payload (e.g. render-preview returns the iframe srcDoc). */
  output?: unknown;
}

export interface PipelineRunState {
  status: PipelineStatus;
  /** epoch ms of the last completed run; stamped by the caller. */
  lastRun: number | null;
  message?: string;
}

export const IDLE_RUN: PipelineRunState = { status: "idle", lastRun: null };
