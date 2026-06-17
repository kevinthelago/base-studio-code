import { describe, it, expect, beforeEach } from "vitest";
import { findPlanGaps, lintPlanHandler, dispatchLintPlan } from "../screens/projects/lintPlan";
import { useAppStore } from "../store";

const ctx = (artifacts: Record<string, string>) => ({
  projectKey: "proj", stageId: "structure", artifacts,
});

describe("lintPlan — findPlanGaps", () => {
  it("flags empty files and unresolved placeholders", () => {
    expect(findPlanGaps({ "goal.md": "Ship the thing." })).toEqual([]);
    expect(findPlanGaps({ "goal.md": "   " })).toEqual(["goal.md: empty"]);
    expect(findPlanGaps({ "scope.md": "In scope: TODO" })[0]).toMatch(/unresolved placeholder/);
    expect(findPlanGaps({ "api.md": "describe the endpoints…" })[0]).toMatch(/unresolved placeholder/);
  });
  it("reports a gap per offending file", () => {
    const gaps = findPlanGaps({ "a.md": "", "b.md": "ok", "c.md": "TBD" });
    expect(gaps).toHaveLength(2);
  });
});

describe("lintPlan — handler", () => {
  it("passes a clean stage and blocks one with gaps", () => {
    expect(lintPlanHandler(ctx({ "goal.md": "done" })).status).toBe("ok");
    const blocked = lintPlanHandler(ctx({ "goal.md": "TODO" }));
    expect(blocked.status).toBe("blocked");
    expect(blocked.message).toMatch(/gap/);
  });
});

describe("lintPlan — dispatch records the run keyed by stage (#534)", () => {
  beforeEach(() => useAppStore.setState({ stagePipelineRuns: {} }));

  it("writes a blocked run for gaps and an ok run for a clean stage", async () => {
    await dispatchLintPlan({ projectKey: "proj", stageId: "structure", artifacts: { "issues.json": "TODO" } });
    let run = useAppStore.getState().stagePipelineRuns["proj"]?.["lint-plan"];
    expect(run?.status).toBe("blocked");

    await dispatchLintPlan({ projectKey: "proj", stageId: "structure", artifacts: { "issues.json": "[]" } });
    run = useAppStore.getState().stagePipelineRuns["proj"]?.["lint-plan"];
    expect(run?.status).toBe("ok");
  });
});
