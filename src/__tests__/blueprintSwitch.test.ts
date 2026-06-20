import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../store";
import type { GradeResult } from "../screens/planner/grading/grading";

describe("blueprint-per-project + reset (#647)", () => {
  beforeEach(() => {
    useAppStore.setState({
      projectBlueprintId: {},
      sectionGrades: { p: { ui: [{ graderId: "x" } as unknown as GradeResult] } },
      uiScreens: { p: ["Home"] },
      uiApproved: { p: ["Home"] },
      planStageConfig: {},
      stagePreview: {},
      stagePipelineRuns: {},
      // section state + fleet/automations also drive completion — must reset too (#664)
      planSections: { p: { goal: "# Goal" } },
      planConfirmedSections: { p: ["goal"] },
      planAutomations: { p: [] },
      projectLocalRepos: { p: ["o/r"] },
    });
  });

  it("setProjectBlueprintId records the id", () => {
    useAppStore.getState().setProjectBlueprintId("p", "api");
    expect(useAppStore.getState().projectBlueprintId["p"]).toBe("api");
  });

  it("applyBlueprintToProject re-seeds the config, records the blueprint, and clears progress (greenfield → transform)", () => {
    useAppStore.getState().setProjectBlueprintId("p", "default"); // greenfield origin
    useAppStore.getState().applyBlueprintToProject("p", "refactor"); // → transform (allowed)
    const s = useAppStore.getState();
    expect(s.projectBlueprintId["p"]).toBe("refactor");
    expect(s.planStageConfig["p"]).toBeTruthy();
    expect(s.planStageConfig["p"].order.length).toBeGreaterThan(0);
    // progress keyed to the old arc is wiped
    expect(s.sectionGrades["p"]).toBeUndefined();
    expect(s.uiScreens["p"]).toBeUndefined();
    expect(s.uiApproved["p"]).toBeUndefined();
    // section state + confirmations + automations also cleared so nothing reads complete (#664)
    expect(s.planSections["p"]).toBeUndefined();
    expect(s.planConfirmedSections["p"]).toBeUndefined();
    expect(s.planAutomations["p"]).toBeUndefined();
    expect(s.projectLocalRepos["p"]).toBeUndefined(); // repos unlinked (#664)
  });

  it("confirmPlanSection / unconfirmPlanSection round-trip (drives the gate, #673)", () => {
    useAppStore.setState({ planConfirmedSections: {} });
    const s = useAppStore.getState();
    s.confirmPlanSection("p", "goal");
    s.confirmPlanSection("p", "goal"); // idempotent
    s.confirmPlanSection("p", "scope");
    expect(useAppStore.getState().planConfirmedSections["p"]).toEqual(["goal", "scope"]);
    s.unconfirmPlanSection("p", "goal");
    expect(useAppStore.getState().planConfirmedSections["p"]).toEqual(["scope"]);
  });

  it("is a no-op for an unknown blueprint", () => {
    useAppStore.getState().applyBlueprintToProject("p", "nope");
    const s = useAppStore.getState();
    expect(s.projectBlueprintId["p"]).toBeUndefined();
    expect(s.sectionGrades["p"]).toBeTruthy(); // untouched
  });

  it("won't switch a project locked to the blueprint-author lifecycle (#923)", () => {
    // bind the project to the authoring lifecycle, then try to switch it away
    useAppStore.getState().setProjectBlueprintId("p", "blueprint-author");
    useAppStore.getState().applyBlueprintToProject("p", "mcp-server");
    const s = useAppStore.getState();
    // the switch is refused — the authoring blueprint overrides + locks the project
    expect(s.projectBlueprintId["p"]).toBe("blueprint-author");
    expect(s.sectionGrades["p"]).toBeTruthy();      // progress NOT wiped
    expect(s.planSections["p"]).toEqual({ goal: "# Goal" });
  });

  it("won't switch greenfield outside transform/harden, nor switch a non-greenfield origin (#923)", () => {
    // greenfield → data is not an allowed target
    useAppStore.getState().setProjectBlueprintId("p", "default");
    useAppStore.getState().applyBlueprintToProject("p", "data-migration");
    expect(useAppStore.getState().projectBlueprintId["p"]).toBe("default"); // refused
    // a transform-origin project can't switch at all
    useAppStore.getState().setProjectBlueprintId("p", "refactor");
    useAppStore.getState().applyBlueprintToProject("p", "harden");
    expect(useAppStore.getState().projectBlueprintId["p"]).toBe("refactor"); // refused
  });
});
