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
import {
  registerPipelineHandler, runPipeline,
  type PipelineHandler, type StageContext, type PipelineRunResult,
} from "./pipelineRuntime";
import type { Pipeline } from "./blueprints";
import { planGradeToResult } from "./gradeDispatch";

export const GRADE_PLAN_ID = "grade-plan";

/** Parse a JSON artifact defensively — a malformed/empty artifact yields the fallback. */
function parseArtifact<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

export const gradePlanHandler: PipelineHandler = (ctx: StageContext): PipelineRunResult => {
  const issues = parseArtifact<PlanIssue[]>(ctx.artifacts["issues.json"], []);
  const phases = parseArtifact<{ name: string }[]>(ctx.artifacts["phases.json"], []);
  const repos  = parseArtifact<string[]>(ctx.artifacts["repos.json"], []);
  const grade  = gradePlan(issues, phases, repos);
  const pct    = Math.round(grade.score * 100);
  // Always `ok`: grading is advisory, so a low grade reports rather than blocks.
  return { status: "ok", message: `Grade ${grade.letter} (${pct}%)`, output: grade };
};

/** Register the builtin (idempotent). Called at module load + safe to call in tests. */
export function registerGradePlan(): void {
  registerPipelineHandler(GRADE_PLAN_ID, gradePlanHandler);
}
registerGradePlan();

const GRADE_PLAN_PIPELINE: Pipeline = {
  uid: GRADE_PLAN_ID, id: GRADE_PLAN_ID, name: "Grade plan",
  desc: "Score agent-readiness of the issues and suggest fixes", suits: ["structure"], kind: "builtin",
  trigger: "on completion", enabled: true, gate: false,
};

/**
 * Run grade-plan for a project and reflect the result in the store: the rich PlanGrade
 * (→ ProjectPane's report) and the run status (→ Blueprints rows). The structure inputs
 * are passed as JSON artifacts so the run flows through the real engine.
 */
export async function dispatchGradePlan(args: {
  projectKey: string; issues: PlanIssue[]; phases: { name: string }[]; repos: string[];
}): Promise<PipelineRunResult> {
  const store = useAppStore.getState();
  store.setStagePipelineRun(args.projectKey, GRADE_PLAN_ID, { status: "running", lastRun: null });
  const ctx: StageContext = {
    projectKey: args.projectKey, stageId: "structure", trigger: "manual",
    artifacts: {
      "issues.json": JSON.stringify(args.issues),
      "phases.json": JSON.stringify(args.phases),
      "repos.json":  JSON.stringify(args.repos),
    },
  };
  const result = await runPipeline(GRADE_PLAN_PIPELINE, ctx);
  if (result.status === "ok" && result.output) {
    const grade = result.output as PlanGrade;
    store.setStagePlanGrade(args.projectKey, grade);
    // Also surface it in the per-section report card as the "Agent readiness" grader,
    // so it sits alongside any rubric grader on the structure section (#615 slice c).
    store.setSectionGrade(args.projectKey, "structure", planGradeToResult(grade));
  }
  store.setStagePipelineRun(args.projectKey, GRADE_PLAN_ID, { status: result.status, lastRun: Date.now(), message: result.message });
  return result;
}
