// lint-plan pipeline (#528/#534) — a second builtin that proves the engine beyond
// render-preview and exercises the GATE path. It scans a stage's artifacts for gaps
// (empty files / unresolved placeholders) and returns `blocked` until they're resolved,
// so when configured as a gate (#532) it keeps the stage incomplete.
//
// Pure scanner (findPlanGaps) + the handler/dispatch. Runs in-app; no backend.

import { useAppStore } from "../../store";
import { registerPipelineHandler, runPipeline, type PipelineHandler, type StageContext, type PipelineRunResult } from "./pipelineRuntime";
import type { Pipeline } from "./blueprints";

export const LINT_PLAN_ID = "lint-plan";

// Unresolved-placeholder markers a finished plan section shouldn't contain.
const PLACEHOLDER_RE = /\b(TODO|TBD|FIXME|XXX|TKTK|placeholder)\b|\.\.\.(?!\.)|…/i;

/** Gaps in a stage's artifacts: empty files or unresolved placeholders. Pure. */
export function findPlanGaps(artifacts: Record<string, string>): string[] {
  const gaps: string[] = [];
  for (const [file, content] of Object.entries(artifacts)) {
    const text = (content ?? "").trim();
    if (!text) gaps.push(`${file}: empty`);
    else if (PLACEHOLDER_RE.test(text)) gaps.push(`${file}: unresolved placeholder`);
  }
  return gaps;
}

export const lintPlanHandler: PipelineHandler = (ctx: StageContext): PipelineRunResult => {
  const gaps = findPlanGaps(ctx.artifacts as Record<string, string>);
  if (gaps.length === 0) return { status: "ok", message: "no gaps", output: { gaps: [] } };
  return {
    status: "blocked",
    message: `${gaps.length} gap${gaps.length !== 1 ? "s" : ""}: ${gaps.slice(0, 3).join("; ")}${gaps.length > 3 ? "…" : ""}`,
    output: { gaps },
  };
};

/** Register the builtin (idempotent). Called at module load + safe to call in tests. */
export function registerLintPlan(): void {
  registerPipelineHandler(LINT_PLAN_ID, lintPlanHandler);
}
registerLintPlan();

const LINT_PLAN_PIPELINE: Pipeline = {
  uid: LINT_PLAN_ID, id: LINT_PLAN_ID, name: "Lint plan",
  desc: "Validate this stage's output for gaps", suits: ["*"], kind: "builtin",
  trigger: "on completion", enabled: true, gate: true,
};

/**
 * Run lint-plan for a stage and record the run. The run state is keyed by the blueprint
 * section pipeline's uid (so the gate wiring in Planning — isGateBlocked(section.pipelines,
 * runs) — reflects it); falls back to the builtin id for ad-hoc runs. #533 wires the
 * triggers (on-completion / manual) that call this with the section's real artifacts.
 */
export async function dispatchLintPlan(args: {
  projectKey: string; stageId: string; artifacts: Record<string, string>; pipelineUid?: string;
}): Promise<PipelineRunResult> {
  const store = useAppStore.getState();
  const key = args.pipelineUid ?? LINT_PLAN_ID;
  store.setStagePipelineRun(args.projectKey, key, { status: "running", lastRun: null });
  const ctx: StageContext = { projectKey: args.projectKey, stageId: args.stageId, artifacts: args.artifacts, trigger: "manual" };
  const result = await runPipeline(LINT_PLAN_PIPELINE, ctx);
  store.setStagePipelineRun(args.projectKey, key, { status: result.status, lastRun: Date.now(), message: result.message });
  return result;
}
