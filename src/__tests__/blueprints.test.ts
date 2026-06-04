import { describe, it, expect } from "vitest";
import { starterBlueprints, cloneStageConfig, DEFAULT_BLUEPRINT_ID } from "../screens/projects/blueprints";
import { PLAN_STAGES } from "../screens/projects/planStages";

describe("blueprints — starters", () => {
  it("includes the default blueprint id and marks starters builtin", () => {
    const bps = starterBlueprints();
    expect(bps.find((b) => b.id === DEFAULT_BLUEPRINT_ID)).toBeTruthy();
    expect(bps.every((b) => b.builtin)).toBe(true);
  });

  it("each starter config covers every stage id", () => {
    for (const b of starterBlueprints()) {
      expect(b.config.order.length).toBe(PLAN_STAGES.length);
      for (const s of PLAN_STAGES) expect(b.config.enabled[s.id]).toBeTypeOf("boolean");
    }
  });

  it("CLI / API presets disable the UI stage; web/3d keep it on", () => {
    const by = Object.fromEntries(starterBlueprints().map((b) => [b.id, b]));
    expect(by["cli-tool"].config.enabled.ui).toBe(false);
    expect(by["api-service"].config.enabled.ui).toBe(false);
    expect(by["web-app"].config.enabled.ui).toBe(true);
    expect(by["3d-app"].config.enabled.ui).toBe(true);
  });

  it("cloneStageConfig produces an independent copy", () => {
    const src = starterBlueprints()[0].config;
    const copy = cloneStageConfig(src);
    copy.enabled.context = false;
    copy.order.reverse();
    expect(src.enabled.context).toBe(true);
    expect(src.order).not.toEqual(copy.order);
  });
});
