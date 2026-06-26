import { describe, it, expect } from "vitest";
import { proposeStages, defaultSignals, stageApplies } from "./classification";
import { type StageId } from "./planStages";

/** The set of enabled stage ids proposed for a signal set, for terse assertions. */
const on = (over = {}): StageId[] => {
  const cfg = proposeStages(defaultSignals(over));
  return Object.entries(cfg.enabled).filter(([, v]) => v).map(([k]) => k as StageId);
};

describe("proposeStages — signal-driven stage selection (#1395)", () => {
  it("Discovery (context) is always proposed", () => {
    expect(on({ lifecycle: "maintain", surfaces: [] })).toContain("context");
  });

  it("greenfield UI app → context, repos, features, ui, structure, permissions", () => {
    const got = on({ lifecycle: "greenfield", surfaces: ["ui", "api"], featureCount: 3, repoCount: 1 });
    expect(new Set(got)).toEqual(new Set(["context", "repos", "features", "ui", "structure", "permissions"]));
    // opt-in + irrelevant stages stay off
    expect(got).not.toContain("source");
    expect(got).not.toContain("automations");
    expect(got).not.toContain("skills");
  });

  it("transform (refactor) of a service → context, repos, permissions; no greenfield-only stages", () => {
    const got = on({ lifecycle: "transform", surfaces: ["service"], provenance: "existing", repoCount: 1 });
    expect(new Set(got)).toEqual(new Set(["context", "repos", "permissions"]));
    expect(got).not.toContain("features"); // greenfield-only
    expect(got).not.toContain("structure");
    expect(got).not.toContain("ui");
  });

  it("data migration → source lights up; repos/permissions follow the software surface", () => {
    const got = on({ lifecycle: "transform", migration: true, dataModel: true, surfaces: ["api", "data"] });
    expect(got).toContain("source");
    expect(got).toContain("context");
    expect(got).toContain("repos");        // api is a software surface
    expect(got).not.toContain("features"); // not greenfield
  });

  it("a pure data project (surfaces=[data]) proposes no software stages", () => {
    const got = on({ lifecycle: "transform", migration: true, surfaces: ["data"] });
    expect(new Set(got)).toEqual(new Set(["context", "source"]));
    expect(got).not.toContain("repos");
    expect(got).not.toContain("permissions");
  });

  it("maintain never proposes a fleet (permissions) or features", () => {
    const got = on({ lifecycle: "maintain", surfaces: ["service"], repoCount: 1 });
    expect(got).toContain("repos");
    expect(got).not.toContain("permissions");
    expect(got).not.toContain("features");
  });

  it("structure needs greenfield AND scale (≥2 features or >1 repo)", () => {
    expect(on({ lifecycle: "greenfield", surfaces: ["cli"], featureCount: 1, repoCount: 1 })).not.toContain("structure");
    expect(on({ lifecycle: "greenfield", surfaces: ["cli"], featureCount: 2, repoCount: 1 })).toContain("structure");
    expect(on({ lifecycle: "greenfield", surfaces: ["cli"], featureCount: 1, repoCount: 2 })).toContain("structure");
  });

  it("automations + skills are opt-in — never proposed from signals", () => {
    expect(stageApplies("automations", defaultSignals({ lifecycle: "greenfield", surfaces: ["ui"] }))).toBe(false);
    expect(stageApplies("skills", defaultSignals({ lifecycle: "greenfield", surfaces: ["ui"] }))).toBe(false);
  });

  it("preserves the registry order in the proposed config", () => {
    const cfg = proposeStages(defaultSignals({ surfaces: ["ui"] }));
    expect(cfg.order).toEqual(["context", "repos", "source", "features", "ui", "structure", "permissions", "automations", "skills"]);
  });
});
