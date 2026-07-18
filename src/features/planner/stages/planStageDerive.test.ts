import { describe, it, expect } from "vitest";
import { derivePlanStageState, planStateToSignals, type DerivePlanStageInput } from "./planStageDerive";

const BASE_INPUT: DerivePlanStageInput = {
  sections: [],
  discoveryRequired: [],
  repoCount: 0,
  issueCount: 0,
  fleetStreams: 0,
  fleetProfilesComplete: false,
  automationsAck: false,
  skillsAck: false,
  requiresUi: false,
  ui: { approved: 0, total: 0 },
  features: { count: 0, allConfirmed: false },
};

describe("derivePlanStageState — Data Model signals", () => {
  it("defaults all Data Model signals to false when they are absent", () => {
    const s = derivePlanStageState(BASE_INPUT);
    expect(s.dataModel).toEqual({
      sourceReachable: false,
      modelInferred: false,
      schemaRefined: false,
      mappingComplete: false,
      loadVerified: false,
    });
  });

  it("maps a fully-present Data Model signal set", () => {
    const s = derivePlanStageState({
      ...BASE_INPUT,
      dataModelSignals: {
        sourceReachable: true,
        modelInferred: true,
        schemaRefined: true,
        mappingComplete: true,
        loadVerified: true,
      },
    });
    expect(s.dataModel).toEqual({
      sourceReachable: true,
      modelInferred: true,
      schemaRefined: true,
      mappingComplete: true,
      loadVerified: true,
    });
  });

  it("treats absent individual fields as false (partial signal set)", () => {
    // The scan fills the signals in incrementally, so a partial set is normal;
    // only modelInferred is set in this fixture.
    const s = derivePlanStageState({
      ...BASE_INPUT,
      dataModelSignals: { modelInferred: true },
    });
    expect(s.dataModel.modelInferred).toBe(true);
    expect(s.dataModel.sourceReachable).toBe(false);
    expect(s.dataModel.schemaRefined).toBe(false);
    expect(s.dataModel.mappingComplete).toBe(false);
    expect(s.dataModel.loadVerified).toBe(false);
  });
});

describe("derivePlanStageState — context generation gate (#1019/#1028)", () => {
  const written = (k: string) => ({ k, state: "drafted" as const });

  it("does NOT pass with an empty required set (stage can't auto-pass before seeding)", () => {
    const s = derivePlanStageState({ ...BASE_INPUT, sections: [written("goal")] });
    expect(s.discovery.requiredDiscoveryReady).toBe(false);
    expect(s.discovery.total).toBe(0);
  });

  it("passes once every required topic's file is WRITTEN — no confirmation needed", () => {
    const s = derivePlanStageState({
      ...BASE_INPUT,
      discoveryRequired: ["goal", "scope"],
      sections: [written("goal"), written("scope")], // drafted (written), not confirmed
    });
    expect(s.discovery.total).toBe(2);
    expect(s.discovery.resolved).toBe(2);
    expect(s.discovery.requiredDiscoveryReady).toBe(true);
    expect(planStateToSignals(s).requiredDiscoveryReady).toBe(true);
  });

  it("blocks while a required topic is unwritten; ignores optional (non-required) files", () => {
    const s = derivePlanStageState({
      ...BASE_INPUT,
      discoveryRequired: ["goal", "users"],
      sections: [written("goal"), written("ux")], // users not written; ux isn't required
    });
    expect(s.discovery.resolved).toBe(1);
    expect(s.discovery.requiredDiscoveryReady).toBe(false);
  });

  it("a required topic with no file does NOT pass (file must exist)", () => {
    const s = derivePlanStageState({ ...BASE_INPUT, discoveryRequired: ["goal"], sections: [] });
    expect(s.discovery.requiredDiscoveryReady).toBe(false);
  });
});

describe("derivePlanStageState — migrationSourceEnabled", () => {
  it("defaults to false when absent", () => {
    const s = derivePlanStageState(BASE_INPUT);
    expect(s.migrationSourceEnabled).toBe(false);
  });

  it("passes through when explicitly set", () => {
    const s = derivePlanStageState({ ...BASE_INPUT, migrationSourceEnabled: true });
    expect(s.migrationSourceEnabled).toBe(true);
  });
});

describe("planStateToSignals — Data Model signals emitted", () => {
  it("emits all five Data Model signals as false when they are empty", () => {
    const s = derivePlanStageState(BASE_INPUT);
    const sig = planStateToSignals(s);
    expect(sig.sourceReachable).toBe(false);
    expect(sig.modelInferred).toBe(false);
    expect(sig.schemaRefined).toBe(false);
    expect(sig.mappingComplete).toBe(false);
    expect(sig.loadVerified).toBe(false);
  });

  it("emits modelInferred + schemaRefined true when artifact has them", () => {
    const s = derivePlanStageState({
      ...BASE_INPUT,
      dataModelSignals: { modelInferred: true, schemaRefined: true },
    });
    const sig = planStateToSignals(s);
    expect(sig.modelInferred).toBe(true);
    expect(sig.schemaRefined).toBe(true);
    expect(sig.sourceReachable).toBe(false);
  });

  it("emits the full set when all artifact fields are true", () => {
    const s = derivePlanStageState({
      ...BASE_INPUT,
      dataModelSignals: {
        sourceReachable: true,
        modelInferred: true,
        schemaRefined: true,
        mappingComplete: true,
        loadVerified: true,
      },
    });
    const sig = planStateToSignals(s);
    expect(sig.sourceReachable).toBe(true);
    expect(sig.modelInferred).toBe(true);
    expect(sig.schemaRefined).toBe(true);
    expect(sig.mappingComplete).toBe(true);
    expect(sig.loadVerified).toBe(true);
  });

  it("preserves existing signals alongside new Data Model signals", () => {
    const s = derivePlanStageState({
      ...BASE_INPUT,
      repoCount: 2,
      dataModelSignals: { modelInferred: true },
    });
    const sig = planStateToSignals(s);
    expect(sig.repoCount).toBe(2);
    expect(sig.modelInferred).toBe(true);
  });
});

describe("dependencies signal (#1111)", () => {
  it("defaults to zero when no manifest is provided", () => {
    const s = derivePlanStageState(BASE_INPUT);
    expect(s.dependencies.count).toBe(0);
    expect(planStateToSignals(s).dependenciesDefined).toBe(0);
  });

  it("emits dependenciesDefined as the locked count — the gate (≥1) passes once any is defined", () => {
    const s = derivePlanStageState({ ...BASE_INPUT, dependencies: { count: 3 } });
    expect(planStateToSignals(s).dependenciesDefined).toBe(3);
  });
});
