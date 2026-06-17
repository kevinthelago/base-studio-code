import { describe, it, expect, beforeEach } from "vitest";
import { gradePlanHandler, dispatchGradePlan, GRADE_PLAN_ID } from "../screens/projects/gradePlan";
import type { PlanIssue } from "../screens/projects/planIssues";
import type { PlanGrade } from "../lib/planGrade";
import { useAppStore } from "../store";

const issue = (p: Partial<PlanIssue>): PlanIssue => ({
  ref: "F1", title: "Do the thing properly here", acceptance: ["a", "b"], owns: ["src/**"],
  dependsOn: [], labels: [], phase: 1, stream: "s", repo: "acme/web", ...p,
});

const ctx = (issues: PlanIssue[], phases: { name: string }[], repos: string[]) => ({
  projectKey: "proj", stageId: "structure",
  artifacts: {
    "issues.json": JSON.stringify(issues),
    "phases.json": JSON.stringify(phases),
    "repos.json":  JSON.stringify(repos),
  },
});

const phases = [{ name: "Phase 1" }];

describe("gradePlan — handler", () => {
  it("is advisory — always ok, with a letter+percent message and the full grade as output", async () => {
    const r = gradePlanHandler(ctx([issue({}), issue({ ref: "F2" })], phases, ["acme/web"]));
    expect(r.status).toBe("ok"); // never blocks
    expect(r.message).toMatch(/Grade [A-F] \(\d+%\)/);
    const grade = r.output as PlanGrade;
    expect(grade.letter).toBe("A");
    expect(grade.categories.length).toBeGreaterThan(0);
  });

  it("tolerates empty/malformed artifacts (F, no throw)", async () => {
    const r = gradePlanHandler({ projectKey: "p", stageId: "structure", artifacts: {} });
    expect(r.status).toBe("ok");
    expect((r.output as PlanGrade).letter).toBe("F");
  });

  it("surfaces suggestions for a weak plan", async () => {
    const weak = [issue({ ref: "W1", acceptance: [], owns: [], stream: undefined, title: "x" })];
    const grade = gradePlanHandler(ctx(weak, phases, ["acme/web"])).output as PlanGrade;
    expect(grade.suggestions.length).toBeGreaterThan(0);
    expect(grade.suggestions.some(s => s.priority === "high")).toBe(true);
  });
});

describe("gradePlan — dispatch persists the grade for the pane", () => {
  beforeEach(() => useAppStore.setState({ stagePipelineRuns: {}, sectionGrades: {} }));

  it("writes the agent-readiness section grade (with rich detail) and an ok run state", async () => {
    await dispatchGradePlan({ projectKey: "proj", issues: [issue({}), issue({ ref: "F2" })], phases, repos: ["acme/web"] });
    const grade = useAppStore.getState().sectionGrades["proj"]?.["structure"]?.find(g => g.graderId === "grade-plan");
    expect(grade?.letter).toBe("A");
    expect((grade?.detail as { letter?: string } | undefined)?.letter).toBe("A"); // rich PlanGrade rides along
    expect(useAppStore.getState().stagePipelineRuns["proj"][GRADE_PLAN_ID].status).toBe("ok");
  });
});
