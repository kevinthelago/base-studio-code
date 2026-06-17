// lint-plan pipeline (#528/#534) — a second builtin that proves the engine beyond
// render-preview and exercises the GATE path. It scans a stage's artifacts for gaps
// (empty files / unresolved placeholders) and returns `blocked` until they're resolved,
// so when configured as a gate (#532) it keeps the stage incomplete.
//
// Pure scanner (findPlanGaps) + the handler/dispatch. Runs in-app; no backend.

import { useAppStore } from "../../store";
import { type StageContext, type PipelineRunResult } from "./pipelineRuntime";

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

/** The lint-plan stage helper: flag empty files / unresolved placeholders in a stage's
 *  artifacts (`blocked` until resolved). Runs by direct dispatch (#897 Phase 4c removed the
 *  generic engine); folds into the stage gate in Phase 4b. */
export function lintPlanHandler(ctx: StageContext): PipelineRunResult {
  const gaps = findPlanGaps(ctx.artifacts as Record<string, string>);
  if (gaps.length === 0) return { status: "ok", message: "no gaps", output: { gaps: [] } };
  return {
    status: "blocked",
    message: `${gaps.length} gap${gaps.length !== 1 ? "s" : ""}: ${gaps.slice(0, 3).join("; ")}${gaps.length > 3 ? "…" : ""}`,
    output: { gaps },
  };
}

/** Run lint-plan for a stage and record the run, keyed by stage id. Calls the handler directly. */
export async function dispatchLintPlan(args: {
  projectKey: string; stageId: string; artifacts: Record<string, string>; pipelineUid?: string;
}): Promise<PipelineRunResult> {
  const store = useAppStore.getState();
  const key = args.pipelineUid ?? LINT_PLAN_ID;
  store.setStagePipelineRun(args.projectKey, key, { status: "running", lastRun: null });
  const ctx: StageContext = { projectKey: args.projectKey, stageId: args.stageId, artifacts: args.artifacts };
  const result = lintPlanHandler(ctx);
  store.setStagePipelineRun(args.projectKey, key, { status: result.status, lastRun: Date.now(), message: result.message });
  return result;
}
