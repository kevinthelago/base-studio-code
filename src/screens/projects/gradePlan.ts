// grade-plan pipeline (#445 → pipeline cutover). Wraps the pure, deterministic
// readiness grader (src/lib/planGrade.ts) as a builtin pipeline so it runs through
// the engine like lint-plan / render-preview: triggered on the structure stage,
// run-stateful, and renderable. Advisory only — it never gates (the letter is shown,
// a weak plan is flagged, but launch is not hard-blocked).
//
// The pure logic stays in lib/planGrade.ts; this is just the handler + dispatch that
// feeds it the structure inputs and persists the rich PlanGrade for the pane to render.

import { useAppStore } from "../../store";
import { gradePlan, type PlanGrade } from "../../lib/planGrade";
import type { PlanIssue } from "./planIssues";
import { type StageContext, type PipelineRunResult } from "./pipelineRuntime";
import { planGradeToResult } from "./gradeDispatch";

export const GRADE_PLAN_ID = "grade-plan";

/** Parse a JSON artifact defensively — a malformed/empty artifact yields the fallback. */
function parseArtifact<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

/** The grade-plan stage helper: score the plan's agent-readiness (advisory — always `ok`).
 *  Runs by direct dispatch (#897 Phase 4c removed the generic engine). Will be replaced by
 *  the plan-grader MCP server in Phase 4b — a localized swap of this one function. */
export function gradePlanHandler(ctx: StageContext): PipelineRunResult {
  const issues = parseArtifact<PlanIssue[]>(ctx.artifacts["issues.json"], []);
  const phases = parseArtifact<{ name: string }[]>(ctx.artifacts["phases.json"], []);
  const repos  = parseArtifact<string[]>(ctx.artifacts["repos.json"], []);
  const grade  = gradePlan(issues, phases, repos);
  const pct    = Math.round(grade.score * 100);
  // Always `ok`: grading is advisory, so a low grade reports rather than blocks.
  return { status: "ok", message: `Grade ${grade.letter} (${pct}%)`, output: grade };
}

/**
 * Run grade-plan for a project and reflect the result in the store: the rich PlanGrade
 * (→ ProjectPane's report) and the run status. Calls the handler directly.
 */
export async function dispatchGradePlan(args: {
  projectKey: string; issues: PlanIssue[]; phases: { name: string }[]; repos: string[];
}): Promise<PipelineRunResult> {
  const store = useAppStore.getState();
  store.setStagePipelineRun(args.projectKey, GRADE_PLAN_ID, { status: "running", lastRun: null });
  const ctx: StageContext = {
    projectKey: args.projectKey, stageId: "structure",
    artifacts: {
      "issues.json": JSON.stringify(args.issues),
      "phases.json": JSON.stringify(args.phases),
      "repos.json":  JSON.stringify(args.repos),
    },
  };
  let result: PipelineRunResult;
  try { result = gradePlanHandler(ctx); }
  catch (e) { result = { status: "fail", message: String(e) }; }
  if (result.status === "ok" && result.output) {
    // Single source of truth (#615): the agent-readiness grade is stored as a section
    // grader result; its full PlanGrade rides along as `detail` for the rich report.
    store.setSectionGrade(args.projectKey, "structure", planGradeToResult(result.output as PlanGrade));
  }
  store.setStagePipelineRun(args.projectKey, GRADE_PLAN_ID, { status: result.status, lastRun: Date.now(), message: result.message });
  return result;
}
