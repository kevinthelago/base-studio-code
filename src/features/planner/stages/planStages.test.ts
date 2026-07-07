import { describe, it, expect } from "vitest";
import {
  PLAN_STAGES, STAGE_BY_ID, defaultStageConfig, discoveryOnlyStageConfig,
  enabledOrderedStages,
  type StageConfig, type StageId,
} from "./planStages";

function cfg(over: Partial<StageConfig> = {}): StageConfig {
  const d = defaultStageConfig();
  return { enabled: { ...d.enabled, ...(over.enabled ?? {}) }, order: over.order ?? d.order };
}

describe("planStages — registry", () => {
  it("default config honors each stage's defaultEnabled, in registry order", () => {
    const d = defaultStageConfig();
    expect(d.order).toEqual(PLAN_STAGES.map((s) => s.id));
    // Every stage but the opt-in market stage (#2430, defaultEnabled: false) starts on.
    expect(PLAN_STAGES.every((s) => d.enabled[s.id] === s.defaultEnabled)).toBe(true);
    expect(d.enabled.market).toBe(false);
    expect(PLAN_STAGES.filter((s) => s.id !== "market").every((s) => d.enabled[s.id])).toBe(true);
  });

  it("discoveryOnlyStageConfig enables only Discovery, preserving registry order (#1395)", () => {
    const c = discoveryOnlyStageConfig();
    expect(c.order).toEqual(PLAN_STAGES.map((s) => s.id));
    expect(c.enabled.discovery).toBe(true);
    // every non-discovery stage starts OFF — they light up additively from discovery signals.
    expect(PLAN_STAGES.filter((s) => s.id !== "discovery").every((s) => c.enabled[s.id] === false)).toBe(true);
    // only Discovery renders in the bar.
    expect(enabledOrderedStages(c).map((s) => s.id)).toEqual(["discovery"]);
  });

  it("default order puts ui before streams (#510/#1914)", () => {
    const order = defaultStageConfig().order;
    expect(order.indexOf("ui")).toBeLessThan(order.indexOf("streams"));
  });

  it("only discovery is required; every other stage is optional", () => {
    expect(STAGE_BY_ID.discovery.optional).toBe(false);
    expect(PLAN_STAGES.filter((s) => s.id !== "discovery").every((s) => s.optional)).toBe(true);
  });

  it("load is in StageId but has no PLAN_STAGES entry (signal-only)", () => {
    // "load" is a valid StageId for signal reference only — it intentionally has no bar entry.
    expect(STAGE_BY_ID["load" as StageId]).toBeUndefined();
  });

  it("source appears in PLAN_STAGES between deployment and features (#1914)", () => {
    const ids = PLAN_STAGES.map((s) => s.id);
    expect(ids.indexOf("source")).toBeGreaterThan(ids.indexOf("deployment"));
    expect(ids.indexOf("source")).toBeLessThan(ids.indexOf("features"));
  });
});

describe("planStages — enabledOrderedStages", () => {
  it("returns only enabled stages, in configured order", () => {
    const c = cfg({
      enabled: { ...defaultStageConfig().enabled, ui: false, skills: false },
      order: ["deployment", "discovery", "streams", "automations", "ui", "skills"],
    });
    expect(enabledOrderedStages(c).map((s) => s.id)).toEqual(["deployment", "discovery", "streams", "automations"]);
  });
});
