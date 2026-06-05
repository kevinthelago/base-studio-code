import { describe, it, expect, beforeEach } from "vitest";
import { findPlanGaps, lintPlanHandler, dispatchLintPlan, LINT_PLAN_ID } from "../screens/projects/lintPlan";
import { hasPipelineHandler, isGateBlocked } from "../screens/projects/pipelineRuntime";
import { mkSection } from "../screens/projects/blueprints";
import { useAppStore } from "../store";

const ctx = (artifacts: Record<string, string>) => ({
  projectKey: "proj", stageId: "structure", artifacts, trigger: "manual" as const,
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
  it("registers itself into the engine on import", () => {
    expect(hasPipelineHandler(LINT_PLAN_ID)).toBe(true);
  });
  it("passes a clean stage and blocks one with gaps", async () => {
    expect((await lintPlanHandler(ctx({ "goal.md": "done" }), {} as never)).status).toBe("ok");
    const blocked = await lintPlanHandler(ctx({ "goal.md": "TODO" }), {} as never);
    expect(blocked.status).toBe("blocked");
    expect(blocked.message).toMatch(/gap/);
  });
});

describe("lintPlan — dispatch + gate integration (#532/#534)", () => {
  beforeEach(() => useAppStore.setState({ stagePipelineRuns: {} }));

  it("records the run keyed by the section pipeline uid, blocking the stage gate", async () => {
    // A structure section with a lint-plan gate pipeline.
    const section = mkSection("structure", { pipelines: [["lint-plan", "on completion", true]] });
    const pl = section.pipelines[0];
    pl.gate = true;

    // Gaps → blocked run → the section's gate is blocked.
    await dispatchLintPlan({ projectKey: "proj", stageId: "structure", artifacts: { "issues.json": "TODO" }, pipelineUid: pl.uid });
    let runs = useAppStore.getState().stagePipelineRuns["proj"];
    expect(runs[pl.uid].status).toBe("blocked");
    expect(isGateBlocked(section.pipelines, runs)).toBe(true);

    // Clean → ok run → gate clears.
    await dispatchLintPlan({ projectKey: "proj", stageId: "structure", artifacts: { "issues.json": "[]" }, pipelineUid: pl.uid });
    runs = useAppStore.getState().stagePipelineRuns["proj"];
    expect(runs[pl.uid].status).toBe("ok");
    expect(isGateBlocked(section.pipelines, runs)).toBe(false);
  });
});
