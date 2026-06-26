import { describe, it, expect } from "vitest";
import {
  PLAN_STAGES, STAGE_BY_ID, defaultStageConfig, discoveryOnlyStageConfig, buildPlanStageState,
  stageStatus, enabledOrderedStages, currentStage, BUILT_IN_BLUEPRINTS, resolveEnabledStages,
  type StageConfig, type StageId,
} from "./planStages";

function cfg(over: Partial<StageConfig> = {}): StageConfig {
  const d = defaultStageConfig();
  return { enabled: { ...d.enabled, ...(over.enabled ?? {}) }, order: over.order ?? d.order };
}
const status = (id: StageId, state: ReturnType<typeof buildPlanStageState>, c = cfg()) =>
  stageStatus(STAGE_BY_ID[id], state, c).status;

describe("planStages — registry", () => {
  it("default config is all-on in registry order", () => {
    const d = defaultStageConfig();
    expect(d.order).toEqual(PLAN_STAGES.map((s) => s.id));
    expect(Object.values(d.enabled).every(Boolean)).toBe(true);
  });

  it("discoveryOnlyStageConfig enables only Discovery (context), preserving registry order (#1395)", () => {
    const c = discoveryOnlyStageConfig();
    expect(c.order).toEqual(PLAN_STAGES.map((s) => s.id));
    expect(c.enabled.discovery).toBe(true);
    // every non-context stage starts OFF — they light up additively from discovery signals.
    expect(PLAN_STAGES.filter((s) => s.id !== "discovery").every((s) => c.enabled[s.id] === false)).toBe(true);
    // only Discovery renders in the bar.
    expect(enabledOrderedStages(c).map((s) => s.id)).toEqual(["discovery"]);
  });

  it("default order puts ui before structure (#510)", () => {
    const order = defaultStageConfig().order;
    expect(order.indexOf("ui")).toBeLessThan(order.indexOf("structure"));
  });
});

describe("planStages — gates", () => {
  it("context completes only when core is confirmed and all topics resolved", () => {
    expect(status("discovery", buildPlanStageState({ discovery: { resolved: 3, total: 6, requiredDiscoveryReady: false } }))).toBe("in-progress");
    expect(status("discovery", buildPlanStageState({ discovery: { resolved: 6, total: 6, requiredDiscoveryReady: false } }))).toBe("in-progress");
    expect(status("discovery", buildPlanStageState({ discovery: { resolved: 6, total: 6, requiredDiscoveryReady: true } }))).toBe("complete");
  });

  it("repos completes with at least one repo", () => {
    expect(status("repos", buildPlanStageState({ repoCount: 0 }))).toBe("in-progress");
    expect(status("repos", buildPlanStageState({ repoCount: 2 }))).toBe("complete");
  });

  it("structure completes only with phases confirmed AND issues", () => {
    const base = { discovery: { resolved: 1, total: 1, requiredDiscoveryReady: true }, repoCount: 1, requiresUi: false, features: { count: 1, allConfirmed: true } };
    expect(status("structure", buildPlanStageState({ ...base, phasesConfirmed: true, issueCount: 0 }))).toBe("in-progress");
    expect(status("structure", buildPlanStageState({ ...base, phasesConfirmed: true, issueCount: 5 }))).toBe("complete");
  });

  it("automations completes on acknowledgement once its structure dep is satisfied", () => {
    // automations depends on structure, so make structure complete first.
    const base = { discovery: { resolved: 1, total: 1, requiredDiscoveryReady: true }, repoCount: 1, requiresUi: false, phasesConfirmed: true, issueCount: 1 };
    expect(status("automations", buildPlanStageState({ ...base, automationsAck: false }))).toBe("in-progress");
    expect(status("automations", buildPlanStageState({ ...base, automationsAck: true }))).toBe("complete");
  });

  it("skills (no deps) completes on acknowledgement (may be empty)", () => {
    expect(status("skills", buildPlanStageState({ skillsAck: false }))).toBe("in-progress");
    expect(status("skills", buildPlanStageState({ skillsAck: true }))).toBe("complete");
  });
});

describe("planStages — applicability", () => {
  it("ui is N/A when the project needs no UI", () => {
    expect(status("ui", buildPlanStageState({ requiresUi: false }))).toBe("na");
  });

  it("ui is in-progress when required but no screens approved", () => {
    // ui now depends on features (#825), so features must be complete for ui to be reachable.
    const s = buildPlanStageState({ requiresUi: true, discovery: { resolved: 1, total: 1, requiredDiscoveryReady: true }, features: { count: 1, allConfirmed: true }, ui: { approved: 0, total: 3 } });
    expect(status("ui", s)).toBe("in-progress");
  });

  it("ui is locked until features are defined (#825)", () => {
    const s = buildPlanStageState({ requiresUi: true, discovery: { resolved: 1, total: 1, requiredDiscoveryReady: true }, features: { count: 0, allConfirmed: false }, ui: { approved: 0, total: 3 } });
    expect(status("ui", s)).toBe("locked");
  });

  it("ui completes when the preview is approved (#544)", () => {
    const s = buildPlanStageState({ requiresUi: true, discovery: { resolved: 1, total: 1, requiredDiscoveryReady: true }, features: { count: 1, allConfirmed: true }, ui: { approved: 1, total: 1 } });
    expect(status("ui", s)).toBe("complete");
  });

  it("ui completes when the design is routed, even with no screens (#837)", () => {
    const s = buildPlanStageState({ requiresUi: true, discovery: { resolved: 1, total: 1, requiredDiscoveryReady: true }, features: { count: 1, allConfirmed: true }, ui: { approved: 0, total: 0, routed: true } });
    expect(status("ui", s)).toBe("complete");
  });
});

describe("planStages — dependency gating", () => {
  it("locks a stage whose enabled dependency is incomplete", () => {
    // structure depends on context+repos+ui; context not done -> locked
    const s = buildPlanStageState({ discovery: { resolved: 0, total: 3, requiredDiscoveryReady: false }, repoCount: 1, requiresUi: false });
    expect(status("structure", s)).toBe("locked");
  });

  it("a disabled dependency counts as satisfied", () => {
    // Disable discovery+repos+ui; structure should no longer be locked by them.
    const c = cfg({ enabled: { ...defaultStageConfig().enabled, discovery: false, repos: false, ui: false, features: false } });
    const s = buildPlanStageState({ phasesConfirmed: false, issueCount: 0 });
    expect(stageStatus(STAGE_BY_ID.structure, s, c).status).toBe("in-progress");
  });

  it("an N/A dependency (ui off via requiresUi) does not block structure", () => {
    const s = buildPlanStageState({ discovery: { resolved: 1, total: 1, requiredDiscoveryReady: true }, repoCount: 1, requiresUi: false, features: { count: 1, allConfirmed: true } });
    // context+repos+features complete, ui N/A -> structure unlocked (in-progress, not locked)
    expect(status("structure", s)).toBe("in-progress");
  });
});

describe("planStages — enabledOrderedStages", () => {
  it("returns only enabled stages, in configured order", () => {
    const c = cfg({
      enabled: { ...defaultStageConfig().enabled, ui: false, skills: false },
      order: ["repos", "discovery", "structure", "permissions", "automations", "ui", "skills"],
    });
    expect(enabledOrderedStages(c).map((s) => s.id)).toEqual(["repos", "discovery", "structure", "permissions", "automations"]);
  });
});

describe("planStages — currentStage (reached frontier)", () => {
  it("is the first in-progress stage when nothing is done yet", () => {
    expect(currentStage(cfg(), buildPlanStageState())?.id).toBe("discovery");
  });

  it("advances past a completed stage to the next in-progress one", () => {
    const state = buildPlanStageState({
      discovery: { resolved: 6, total: 6, requiredDiscoveryReady: true }, // context complete
      requiresUi: false,                                       // ui n/a
      // repos not linked → repos is the next in-progress stage
    });
    expect(currentStage(cfg(), state)?.id).toBe("repos");
  });

  it("skips N/A stages (ui when the project needs no UI)", () => {
    const state = buildPlanStageState({
      discovery: { resolved: 6, total: 6, requiredDiscoveryReady: true },
      repoCount: 1,                              // repos complete
      features: { count: 1, allConfirmed: true }, // features complete
      requiresUi: false,   // ui (now after features, #825) is n/a → skipped → next is structure
    });
    expect(currentStage(cfg(), state)?.id).toBe("structure");
  });

  it("falls back to the last enabled+applicable stage when all are complete", () => {
    const allDone = buildPlanStageState({
      discovery: { resolved: 1, total: 1, requiredDiscoveryReady: true },
      repoCount: 1,
      requiresUi: false,
      features: { count: 2, allConfirmed: true },
      phasesConfirmed: true, issueCount: 3,
      fleet: { streams: 2, profilesComplete: true },
      automationsAck: true,
      skillsAck: true,
    });
    expect(currentStage(cfg(), allDone)?.id).toBe("skills");
  });
});

describe("planStages — source stage (pp-stage)", () => {
  it("source is N/A when migrationSourceEnabled is false (default)", () => {
    expect(status("source", buildPlanStageState({ migrationSourceEnabled: false }))).toBe("na");
  });

  it("source is in-progress when enabled but artifact is empty", () => {
    const s = buildPlanStageState({
      migrationSourceEnabled: true,
      repoCount: 1,
      discovery: { resolved: 1, total: 1, requiredDiscoveryReady: true },
    });
    expect(status("source", s)).toBe("in-progress");
  });

  it("source is locked until context + repos deps are satisfied", () => {
    const s = buildPlanStageState({
      migrationSourceEnabled: true,
      repoCount: 0,   // repos not done
      discovery: { resolved: 0, total: 0, requiredDiscoveryReady: false },
    });
    expect(status("source", s)).toBe("locked");
  });

  it("source completes when modelInferred AND schemaRefined are both true", () => {
    const s = buildPlanStageState({
      migrationSourceEnabled: true,
      repoCount: 1,
      discovery: { resolved: 1, total: 1, requiredDiscoveryReady: true },
      datamodel: { sourceReachable: true, modelInferred: true, schemaRefined: true, mappingComplete: false, loadVerified: false },
    });
    expect(status("source", s)).toBe("complete");
  });

  it("source stays in-progress when only modelInferred is true", () => {
    const s = buildPlanStageState({
      migrationSourceEnabled: true,
      repoCount: 1,
      discovery: { resolved: 1, total: 1, requiredDiscoveryReady: true },
      datamodel: { sourceReachable: false, modelInferred: true, schemaRefined: false, mappingComplete: false, loadVerified: false },
    });
    expect(status("source", s)).toBe("in-progress");
  });

  it("load is in StageId but has no PLAN_STAGES entry (signal-only)", () => {
    // "load" is a valid StageId for signal reference only — it intentionally has no bar entry.
    expect(STAGE_BY_ID["load" as StageId]).toBeUndefined();
  });

  it("source appears in PLAN_STAGES between repos and features", () => {
    const ids = PLAN_STAGES.map((s) => s.id);
    const reposIdx = ids.indexOf("repos");
    const sourceIdx = ids.indexOf("source");
    const featuresIdx = ids.indexOf("features");
    expect(sourceIdx).toBeGreaterThan(reposIdx);
    expect(sourceIdx).toBeLessThan(featuresIdx);
  });
});

describe("planStages — BUILT_IN_BLUEPRINTS (#666/#458)", () => {
  it("includes a 'refactor' blueprint without the structure stage", () => {
    const refactor = BUILT_IN_BLUEPRINTS.find((b) => b.id === "refactor");
    expect(refactor).toBeDefined();
    expect(refactor!.enabledStages).not.toContain("structure");
    expect(refactor!.enabledStages).toContain("discovery");
    expect(refactor!.enabledStages).toContain("permissions");
  });

  it("resolveEnabledStages forces only context (the sole required stage) — structure is optional (#666)", () => {
    const refactor = BUILT_IN_BLUEPRINTS.find((b) => b.id === "refactor")!;
    const stages = resolveEnabledStages(refactor);
    // context is the only required stage (optional: false), so it is always included
    expect(stages).toContain("discovery");
    // structure is optional — refactor blueprint omits it and resolveEnabledStages respects that
    expect(stages).not.toContain("structure");
    // but the stages the blueprint did enable are present
    expect(stages).toContain("permissions");
  });

  it("all built-in blueprints have unique ids", () => {
    const ids = BUILT_IN_BLUEPRINTS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all built-in blueprints always include context (required stage)", () => {
    for (const bp of BUILT_IN_BLUEPRINTS) {
      const resolved = resolveEnabledStages(bp);
      expect(resolved).toContain("discovery");
    }
  });
});
