import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../store";
import type { GradeResult } from "../screens/projects/grading";

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
    });
  });

  it("setProjectBlueprintId records the id", () => {
    useAppStore.getState().setProjectBlueprintId("p", "api");
    expect(useAppStore.getState().projectBlueprintId["p"]).toBe("api");
  });

  it("applyBlueprintToProject re-seeds the config, records the blueprint, and clears progress", () => {
    useAppStore.getState().applyBlueprintToProject("p", "fullstack");
    const s = useAppStore.getState();
    expect(s.projectBlueprintId["p"]).toBe("fullstack");
    expect(s.planStageConfig["p"]).toBeTruthy();
    expect(s.planStageConfig["p"].order.length).toBeGreaterThan(0);
    // progress keyed to the old arc is wiped
    expect(s.sectionGrades["p"]).toBeUndefined();
    expect(s.uiScreens["p"]).toBeUndefined();
    expect(s.uiApproved["p"]).toBeUndefined();
  });

  it("is a no-op for an unknown blueprint", () => {
    useAppStore.getState().applyBlueprintToProject("p", "nope");
    const s = useAppStore.getState();
    expect(s.projectBlueprintId["p"]).toBeUndefined();
    expect(s.sectionGrades["p"]).toBeTruthy(); // untouched
  });
});
