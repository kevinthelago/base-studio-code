import { describe, it, expect } from "vitest";
import { activeSubstep, substepDone } from "../screens/planner/planSubsteps";
import { SECTION_DEFS, mkSection, makeBlueprints, type SubStep } from "../screens/planner/blueprints";
import { derivePlanStageState, planStateToSignals } from "../screens/planner/planStageDerive";

const STATIC: SubStep[] = [
  { key: "goal", label: "Goal", prompt: "g" },
  { key: "scope", label: "Scope", prompt: "s" },
];
const WITH_LOOP: SubStep[] = [
  { key: "features", label: "Feature workshop", loop: "features", prompt: "f" },
  { key: "phases", label: "Sequence", prompt: "p" },
];

describe("substepDone", () => {
  it("static substep is done when its key is confirmed", () => {
    expect(substepDone(STATIC[0], new Set(["goal"]), false)).toBe(true);
    expect(substepDone(STATIC[0], new Set(), false)).toBe(false);
  });
  it("loop substep ignores confirmed and follows loopDone", () => {
    expect(substepDone(WITH_LOOP[0], new Set(["features"]), false)).toBe(false);
    expect(substepDone(WITH_LOOP[0], new Set(), true)).toBe(true);
  });
});

describe("activeSubstep", () => {
  it("returns the first unconfirmed static substep, in order", () => {
    expect(activeSubstep(STATIC, new Set())?.key).toBe("goal");
    expect(activeSubstep(STATIC, new Set(["goal"]))?.key).toBe("scope");
    expect(activeSubstep(STATIC, new Set(["goal", "scope"]))).toBeUndefined();
  });
  it("holds on a loop substep until loopDone, then advances", () => {
    expect(activeSubstep(WITH_LOOP, new Set())?.key).toBe("features");
    expect(activeSubstep(WITH_LOOP, new Set(), true)?.key).toBe("phases");
  });
  it("handles a missing substeps list", () => {
    expect(activeSubstep(undefined, new Set())).toBeUndefined();
  });
});

describe("authored substeps (built-in sections)", () => {
  it("Context exposes the core-four discovery substeps + a topics loop", () => {
    const keys = (SECTION_DEFS.context.substeps ?? []).map((s) => s.key);
    expect(keys).toEqual(["goal", "scope", "stack", "architecture", "dimensions"]);
    const loop = SECTION_DEFS.context.substeps?.find((s) => s.key === "dimensions");
    expect(loop?.loop).toBe("topics");
  });
  it("Features exposes a propose step then a per-feature loop", () => {
    const subs = SECTION_DEFS.features.substeps ?? [];
    expect(subs.map((s) => s.key)).toEqual(["propose", "features"]);
    expect(subs.find((s) => s.key === "features")?.loop).toBe("features");
  });
  it("Structure (Plan) is autonomous — no substeps", () => {
    expect(SECTION_DEFS.structure.substeps ?? []).toEqual([]);
  });
  it("no built-in substep prompt mentions publishing (user owns publish)", () => {
    for (const def of Object.values(SECTION_DEFS)) {
      for (const s of def.substeps ?? []) {
        expect(s.prompt.toLowerCase()).not.toMatch(/\bpublish|gh repo create|gh issue create|milestone/);
      }
    }
  });
  it("substeps carry onto a built section instance via mkSection", () => {
    expect(mkSection("context").substeps?.length).toBe(5);
  });
});

describe("Features stage (Phase 1)", () => {
  it("the Features gate keys off featuresConfirmed + featuresDefined", () => {
    const signals = (SECTION_DEFS.features.gateRule?.require ?? []).map((r) => r.signal);
    expect(signals).toContain("featuresConfirmed");
    expect(signals).toContain("featuresDefined");
  });

  it("the default blueprint runs Features before the Plan (structure) stage", () => {
    const keys = makeBlueprints().find((b) => b.id === "default")!.sections.map((s) => s.key);
    expect(keys.indexOf("features")).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf("features")).toBeLessThan(keys.indexOf("structure"));
  });

  it("derive → signals surfaces the features count + confirmation", () => {
    const base = {
      sections: [], repoCount: 0, issueCount: 0, fleetStreams: 0, fleetProfilesComplete: false,
      automationsAck: false, skillsAck: false, requiresUi: false, ui: { approved: 0, total: 0 },
    };
    const open = planStateToSignals(derivePlanStageState({ ...base, features: { count: 2, allConfirmed: false } }));
    expect(open.featuresDefined).toBe(2);
    expect(open.featuresConfirmed).toBe(false);
    const done = planStateToSignals(derivePlanStageState({ ...base, features: { count: 2, allConfirmed: true } }));
    expect(done.featuresConfirmed).toBe(true);
  });
});
