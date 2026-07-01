import { describe, it, expect } from "vitest";
import { PLAN_STAGES, STAGE_BY_ID } from "./planStages";

// Guard for the externalized stage registry (@data/planner/stage-registry.json, #2027 P1): the
// canonical ordered stage set + its enable/optional metadata must load through the accessors unchanged.
describe("stage registry (loaded from @data/planner/stage-registry.json)", () => {
  it("loads the 8 stages in canonical pipeline order", () => {
    expect(PLAN_STAGES.map((s) => s.id)).toEqual([
      "discovery", "deployment", "source", "features", "ui", "streams", "automations", "skills",
    ]);
  });

  it("only discovery is required; every stage defaults enabled; ui depends on features (#1404)", () => {
    expect(PLAN_STAGES.filter((s) => !s.optional).map((s) => s.id)).toEqual(["discovery"]);
    expect(PLAN_STAGES.every((s) => s.defaultEnabled)).toBe(true);
    expect(STAGE_BY_ID.ui.dependsOn).toContain("features");
    expect(Object.keys(STAGE_BY_ID).sort()).toEqual([...PLAN_STAGES.map((s) => s.id)].sort());
  });
});
