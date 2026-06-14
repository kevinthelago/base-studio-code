import { describe, it, expect } from "vitest";
import {
  PLAN_STAGES, STAGE_BY_ID, defaultStageConfig, buildPlanStageState,
  stageStatus, enabledOrderedStages, currentStage, BUILT_IN_BLUEPRINTS, resolveEnabledStages,
  type StageConfig, type StageId,
} from "../screens/projects/planStages";

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

  it("default order puts ui before structure (#510)", () => {
    const order = defaultStageConfig().order;
    expect(order.indexOf("ui")).toBeLessThan(order.indexOf("structure"));
  });
});

describe("planStages — gates", () => {
  it("context completes only when core is confirmed and all topics resolved", () => {
    expect(status("context", buildPlanStageState({ context: { resolved: 3, total: 6, coreConfirmed: false } }))).toBe("in-progress");
    expect(status("context", buildPlanStageState({ context: { resolved: 6, total: 6, coreConfirmed: false } }))).toBe("in-progress");
    expect(status("context", buildPlanStageState({ context: { resolved: 6, total: 6, coreConfirmed: true } }))).toBe("complete");
  });

  it("repos completes with at least one repo", () => {
    expect(status("repos", buildPlanStageState({ repoCount: 0 }))).toBe("in-progress");
    expect(status("repos", buildPlanStageState({ repoCount: 2 }))).toBe("complete");
  });

  it("structure completes only with phases confirmed AND issues", () => {
    const base = { context: { resolved: 1, total: 1, coreConfirmed: true }, repoCount: 1, requiresUi: false, features: { count: 1, allConfirmed: true } };
    expect(status("structure", buildPlanStageState({ ...base, phasesConfirmed: true, issueCount: 0 }))).toBe("in-progress");
    expect(status("structure", buildPlanStageState({ ...base, phasesConfirmed: true, issueCount: 5 }))).toBe("complete");
  });

  it("automations completes on acknowledgement once its structure dep is satisfied", () => {
    // automations depends on structure, so make structure complete first.
    const base = { context: { resolved: 1, total: 1, coreConfirmed: true }, repoCount: 1, requiresUi: false, phasesConfirmed: true, issueCount: 1 };
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
    const s = buildPlanStageState({ requiresUi: true, context: { resolved: 1, total: 1, coreConfirmed: true }, features: { count: 1, allConfirmed: true }, ui: { approved: 0, total: 3 } });
    expect(status("ui", s)).toBe("in-progress");
  });

  it("ui is locked until features are defined (#825)", () => {
    const s = buildPlanStageState({ requiresUi: true, context: { resolved: 1, total: 1, coreConfirmed: true }, features: { count: 0, allConfirmed: false }, ui: { approved: 0, total: 3 } });
    expect(status("ui", s)).toBe("locked");
  });

  it("ui completes when the preview is approved (#544)", () => {
    const s = buildPlanStageState({ requiresUi: true, context: { resolved: 1, total: 1, coreConfirmed: true }, features: { count: 1, allConfirmed: true }, ui: { approved: 1, total: 1 } });
    expect(status("ui", s)).toBe("complete");
  });
});

describe("planStages — dependency gating", () => {
  it("locks a stage whose enabled dependency is incomplete", () => {
    // structure depends on context+repos+ui; context not done -> locked
    const s = buildPlanStageState({ context: { resolved: 0, total: 3, coreConfirmed: false }, repoCount: 1, requiresUi: false });
    expect(status("structure", s)).toBe("locked");
  });

  it("a disabled dependency counts as satisfied", () => {
    // Disable context+repos+ui; structure should no longer be locked by them.
    const c = cfg({ enabled: { ...defaultStageConfig().enabled, context: false, repos: false, ui: false, features: false } });
    const s = buildPlanStageState({ phasesConfirmed: false, issueCount: 0 });
    expect(stageStatus(STAGE_BY_ID.structure, s, c).status).toBe("in-progress");
  });

  it("an N/A dependency (ui off via requiresUi) does not block structure", () => {
    const s = buildPlanStageState({ context: { resolved: 1, total: 1, coreConfirmed: true }, repoCount: 1, requiresUi: false, features: { count: 1, allConfirmed: true } });
    // context+repos+features complete, ui N/A -> structure unlocked (in-progress, not locked)
    expect(status("structure", s)).toBe("in-progress");
  });
});

describe("planStages — enabledOrderedStages", () => {
  it("returns only enabled stages, in configured order", () => {
    const c = cfg({
      enabled: { ...defaultStageConfig().enabled, ui: false, skills: false },
      order: ["repos", "context", "structure", "permissions", "automations", "ui", "skills"],
    });
    expect(enabledOrderedStages(c).map((s) => s.id)).toEqual(["repos", "context", "structure", "permissions", "automations"]);
  });
});

describe("planStages — currentStage (reached frontier)", () => {
  it("is the first in-progress stage when nothing is done yet", () => {
    expect(currentStage(cfg(), buildPlanStageState())?.id).toBe("context");
  });

  it("advances past a completed stage to the next in-progress one", () => {
    const state = buildPlanStageState({
      context: { resolved: 6, total: 6, coreConfirmed: true }, // context complete
      requiresUi: false,                                       // ui n/a
      // repos not linked → repos is the next in-progress stage
    });
    expect(currentStage(cfg(), state)?.id).toBe("repos");
  });

  it("skips N/A stages (ui when the project needs no UI)", () => {
    const state = buildPlanStageState({
      context: { resolved: 6, total: 6, coreConfirmed: true },
      repoCount: 1,                              // repos complete
      features: { count: 1, allConfirmed: true }, // features complete
      requiresUi: false,   // ui (now after features, #825) is n/a → skipped → next is structure
    });
    expect(currentStage(cfg(), state)?.id).toBe("structure");
  });

  it("falls back to the last enabled+applicable stage when all are complete", () => {
    const allDone = buildPlanStageState({
      context: { resolved: 1, total: 1, coreConfirmed: true },
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

describe("planStages — BUILT_IN_BLUEPRINTS (#666/#458)", () => {
  it("includes a 'refactor' blueprint without the structure stage", () => {
    const refactor = BUILT_IN_BLUEPRINTS.find((b) => b.id === "refactor");
    expect(refactor).toBeDefined();
    expect(refactor!.enabledStages).not.toContain("structure");
    expect(refactor!.enabledStages).toContain("context");
    expect(refactor!.enabledStages).toContain("permissions");
  });

  it("resolveEnabledStages forces only context (the sole required stage) — structure is optional (#666)", () => {
    const refactor = BUILT_IN_BLUEPRINTS.find((b) => b.id === "refactor")!;
    const stages = resolveEnabledStages(refactor);
    // context is the only required stage (optional: false), so it is always included
    expect(stages).toContain("context");
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
      expect(resolved).toContain("context");
    }
  });
});
