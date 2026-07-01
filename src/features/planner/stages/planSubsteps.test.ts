import { describe, it, expect } from "vitest";
import { activeSubstep, substepDone } from "./planSubsteps";
import { STAGE_DEFS, mkStage, makeBlueprints, type SubStep } from "./blueprints";
import { derivePlanStageState, planStateToSignals } from "./planStageDerive";

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
  it("Context exposes the baseline required substeps + a topics loop", () => {
    const keys = (STAGE_DEFS.discovery.substeps ?? []).map((s) => s.key);
    expect(keys).toEqual(["goal", "scope", "stack", "architecture", "users", "release", "dimensions"]);
    const loop = STAGE_DEFS.discovery.substeps?.find((s) => s.key === "dimensions");
    expect(loop?.loop).toBe("topics");
  });
  it("Features exposes a propose step then a per-feature loop", () => {
    const subs = STAGE_DEFS.features.substeps ?? [];
    expect(subs.map((s) => s.key)).toEqual(["propose", "features"]);
    expect(subs.find((s) => s.key === "features")?.loop).toBe("features");
  });
  it("Streams (Plan substep) sequences the DAG then plans the fleet — issues are generated at publish, #plan-db (#1914)", () => {
    // #1914: structure+permissions collapsed into the `streams` stage — a plan substep (present the
    // dependency graph) then a fleet substep. Issues are still generated at publish, not during planning.
    const subs = STAGE_DEFS.streams.substeps ?? [];
    expect(subs.map((s) => s.key)).toEqual(["plan", "fleet"]);
  });
  it("no built-in substep prompt INSTRUCTS the planner to publish the GitHub structure (user owns publish)", () => {
    // The guard is against an IMPERATIVE to publish (create repos / the board / milestones / issues) —
    // not benign descriptive mentions. #1914's deployment+streams prompts legitimately use "publish" for
    // library package-publishing and say issues are generated "at GitHub-publish time, not during planning".
    for (const def of Object.values(STAGE_DEFS)) {
      for (const s of def.substeps ?? []) {
        expect(s.prompt.toLowerCase()).not.toMatch(
          /gh repo create|gh issue create|\b(publish|create) (the )?(repos|repositories|project board|milestones)\b/,
        );
      }
    }
  });
  it("substeps carry onto a built section instance via mkStage", () => {
    expect(mkStage("discovery").substeps?.length).toBe(7);
  });
});

describe("Features stage (Phase 1)", () => {
  it("the Features gate keys off featuresConfirmed + featuresDefined", () => {
    const signals = (STAGE_DEFS.features.gateRule?.require ?? []).map((r) => r.signal);
    expect(signals).toContain("featuresConfirmed");
    expect(signals).toContain("featuresDefined");
  });

  it("the default blueprint runs Features before the Streams stage (#1914)", () => {
    const keys = makeBlueprints().find((b) => b.id === "default")!.sections.map((s) => s.key);
    expect(keys.indexOf("features")).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf("features")).toBeLessThan(keys.indexOf("streams"));
  });

  it("derive → signals surfaces the features count + confirmation", () => {
    const base = {
      sections: [], discoveryRequired: [], repoCount: 0, issueCount: 0, fleetStreams: 0, fleetProfilesComplete: false,
      automationsAck: false, skillsAck: false, requiresUi: false, ui: { approved: 0, total: 0 },
    };
    const open = planStateToSignals(derivePlanStageState({ ...base, features: { count: 2, allConfirmed: false } }));
    expect(open.featuresDefined).toBe(2);
    expect(open.featuresConfirmed).toBe(false);
    const done = planStateToSignals(derivePlanStageState({ ...base, features: { count: 2, allConfirmed: true } }));
    expect(done.featuresConfirmed).toBe(true);
  });
});
