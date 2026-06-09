// Grade dispatch (#615 slice b) — runs a section's rubric grader and persists the
// GradeResult to the store (project → section → grader). The report-card screen renders
// what this writes. The rubric grader is the deterministic default; later slices add
// the agent-readiness + LLM graders, which persist the same way.

import { useAppStore } from "../../store";
import { type PlanSignals } from "./stageGate";
import { gradeWithRubric, rubricForSection, type GradeResult } from "./grading";

/** The built-in rubric grader's pipeline id (attachable in the blueprint editor). */
export const GRADE_RUBRIC_ID = "grade-rubric";

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
