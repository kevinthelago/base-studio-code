// Grade dispatch (#615 slice b) — runs a section's rubric grader and persists the
// GradeResult to the store (project → section → grader). The report-card screen renders
// what this writes. The rubric grader is the deterministic default; later slices add
// the agent-readiness + LLM graders, which persist the same way.

import { useAppStore } from "../../../store";
import { type PlanSignals } from "../stages/stageGate";
import { gradeWithRubric, rubricForSection, type GradeResult, type Severity } from "./grading";
import { type PlanGrade, type Priority } from "../../../lib/planner/planGrade";

/** The built-in rubric grader's pipeline id (attachable in the blueprint editor). */
export const GRADE_RUBRIC_ID = "grade-rubric";

/** The agent-readiness grader id (the grade-plan pipeline). */
export const AGENT_READINESS_ID = "grade-plan";

const severityOf = (p: Priority): Severity => (p === "high" ? "error" : p === "medium" ? "warn" : "info");

/** Adapt the existing rich PlanGrade (agent-readiness) into a GradeResult so it shows in
 *  the report card as one grader among many (#615 slice c). Its categories become
 *  dimensions; its prioritized suggestions become findings. */
export function planGradeToResult(g: PlanGrade, sectionKey = "structure"): GradeResult {
  return {
    graderId: AGENT_READINESS_ID,
    graderLabel: "Agent readiness",
    sectionKey,
    score: Math.round(g.score * 100),
    letter: g.letter,
    dimensions: g.categories.map((c) => ({ id: c.id, label: c.label, score: Math.round(c.score * 100), note: c.detail })),
    findings: g.suggestions.map((s) => ({ severity: severityOf(s.priority), message: s.title, fix: s.detail })),
    // carry the full PlanGrade so the structure section can still render its rich report
    // (per-issue grades, category examples) — the report card uses only the projection.
    detail: g,
  };
}

export interface RunSectionGradeArgs {
  projectKey: string;
  sectionKey: string;
  /** The section's plan markdown (graded by content heuristics). */
  content?: string;
  /** Live plan signals (for signal-based rubric dimensions). */
  signals?: PlanSignals;
}

/** Grade one section with its default rubric and persist the result. Returns it too. */
export function runSectionGrade({ projectKey, sectionKey, content = "", signals = {} }: RunSectionGradeArgs): GradeResult {
  const result = gradeWithRubric(rubricForSection(sectionKey), { sectionKey, signals, content });
  useAppStore.getState().setSectionGrade(projectKey, sectionKey, result);
  return result;
}
