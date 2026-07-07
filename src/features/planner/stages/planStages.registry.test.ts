import { describe, it, expect } from "vitest";
import { PLAN_STAGES, STAGE_BY_ID } from "./planStages";

// Guard for the externalized stage registry (@data/planner/stage-registry.json, #2027 P1): the
// canonical ordered stage set + its enable/optional metadata must load through the accessors unchanged.
describe("stage registry (loaded from @data/planner/stage-registry.json)", () => {
  it("loads the 9 stages in canonical pipeline order", () => {
    expect(PLAN_STAGES.map((s) => s.id)).toEqual([
      "discovery", "market", "deployment", "source", "features", "ui", "streams", "automations", "skills",
    ]);
  });

  it("only discovery is required; every stage but market defaults enabled; ui depends on features (#1404)", () => {
    expect(PLAN_STAGES.filter((s) => !s.optional).map((s) => s.id)).toEqual(["discovery"]);
    // market (#2430) is the one opt-in stage — blueprints enable it explicitly.
    expect(PLAN_STAGES.filter((s) => !s.defaultEnabled).map((s) => s.id)).toEqual(["market"]);
    expect(STAGE_BY_ID.ui.dependsOn).toContain("features");
    expect(STAGE_BY_ID.market.dependsOn).toEqual(["discovery"]);
    expect(Object.keys(STAGE_BY_ID).sort()).toEqual([...PLAN_STAGES.map((s) => s.id)].sort());
  });
});
