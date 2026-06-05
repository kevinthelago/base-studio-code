// Pipeline runtime engine (#528/#529). The action layer that runs the stage
// pipelines configured in a blueprint (#513/#514): a handler bound to a stage,
// fired by a trigger, that reads the stage's artifacts and acts on them.
//
// Pure + framework-free so the dispatch + contract are unit-testable in isolation.
// Builtin handlers (render-preview #531, generate-issues / lint-plan #534) register
// into the registry; the esbuild→iframe rendering, triggers, and gate wiring live in
// later slices. Distinct from #220's execution "pipelineRuns" (the fleet conductor).

import type { Pipeline, PipelineTrigger } from "./blueprints";

/** Why a run fired. The auto triggers come from PipelineTrigger; `tag` is an explicit
 *  planner-emitted run (manual runs target a chosen pipeline directly). */
export type FiredTrigger = PipelineTrigger | "tag";

/** What a handler receives: the stage's identity, its read-only artifacts, and the
 *  reason the run fired. (Rendering surfaces are added by the render-preview slice.) */
export interface StageContext {
  projectKey: string;
  stageId: string;
  /** Stage artifacts as relpath → contents (read-only). */
  artifacts: Readonly<Record<string, string>>;
  trigger: FiredTrigger;
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
  /** epoch ms of the last completed run; stamped by the caller, kept out of the pure
   *  engine so dispatch stays deterministic/testable. */
  lastRun: number | null;
  message?: string;
}

export const IDLE_RUN: PipelineRunState = { status: "idle", lastRun: null };

export type PipelineHandler = (ctx: StageContext, pipeline: Pipeline) => Promise<PipelineRunResult> | PipelineRunResult;

// ── handler registry ────────────────────────────────────────────────────────
const HANDLERS = new Map<string, PipelineHandler>();

/** Register a builtin handler by pipeline id (idempotent — last registration wins). */
export function registerPipelineHandler(id: string, handler: PipelineHandler): void {
  HANDLERS.set(id, handler);
}
export function getPipelineHandler(id: string): PipelineHandler | undefined {
  return HANDLERS.get(id);
}
export function hasPipelineHandler(id: string): boolean {
  return HANDLERS.has(id);
}
/** Test helper — reset the registry between cases. */
export function _resetPipelineHandlers(): void {
  HANDLERS.clear();
}

// ── trigger dispatch ────────────────────────────────────────────────────────
/**
 * The enabled pipelines on a stage that should auto-run for a fired auto-trigger
 * (`on section enter` / `on artifact change` / `on completion`). Only matching-trigger,
 * enabled pipelines run. Manual / tag runs target a specific pipeline and bypass this
 * — call {@link runPipeline} directly for those.
 */
export function pipelinesForTrigger(pipelines: Pipeline[], fired: PipelineTrigger): Pipeline[] {
  return pipelines.filter((p) => p.enabled && p.trigger === fired);
}

/**
 * Run one pipeline through its registered handler, never throwing: a missing handler
 * or a thrown error becomes a `fail` result so the engine is safe to await in a loop.
 */
export async function runPipeline(pipeline: Pipeline, ctx: StageContext): Promise<PipelineRunResult> {
  const handler = HANDLERS.get(pipeline.id);
  if (!handler) return { status: "fail", message: `no handler registered for pipeline "${pipeline.id}"` };
  try {
    return await handler(ctx, pipeline);
  } catch (e) {
    return { status: "fail", message: String(e) };
  }
}

// ── gate predicate (#532 builds on this) ─────────────────────────────────────
/**
 * Whether a stage is blocked by a gating pipeline (#532): any enabled pipeline marked
 * `gate` whose last run has not passed (`ok`). An unrun or in-progress gate blocks too
 * — the stage stays incomplete until the gate passes. Non-gate pipelines never block.
 */
export function isGateBlocked(pipelines: Pipeline[], runs: Record<string, PipelineRunState>): boolean {
  return pipelines.some((p) => p.enabled && p.gate && runs[p.uid]?.status !== "ok");
}
