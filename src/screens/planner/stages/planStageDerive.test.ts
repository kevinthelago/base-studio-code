import { describe, it, expect } from "vitest";
import { derivePlanStageState, planStateToSignals, type DerivePlanStageInput } from "./planStageDerive";

const BASE_INPUT: DerivePlanStageInput = {
  sections: [],
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

describe("derivePlanStageState — datamodel signals", () => {
  it("defaults all datamodel signals to false when artifact is absent", () => {
    const s = derivePlanStageState(BASE_INPUT);
    expect(s.datamodel).toEqual({
      sourceReachable: false,
      modelInferred: false,
      schemaRefined: false,
      mappingComplete: false,
      loadVerified: false,
    });
  });

  it("maps a fully-present datamodel artifact", () => {
    const s = derivePlanStageState({
      ...BASE_INPUT,
      datamodelArtifact: {
        sourceReachable: true,
        modelInferred: true,
        schemaRefined: true,
        mappingComplete: true,
        loadVerified: true,
      },
    });
    expect(s.datamodel).toEqual({
      sourceReachable: true,
      modelInferred: true,
      schemaRefined: true,
      mappingComplete: true,
      loadVerified: true,
    });
  });

  it("treats absent individual fields as false (partial artifact)", () => {
    // The source-experience stream may write datamodel.json incrementally;
    // only modelInferred is set in this fixture.
    const s = derivePlanStageState({
      ...BASE_INPUT,
      datamodelArtifact: { modelInferred: true },
    });
    expect(s.datamodel.modelInferred).toBe(true);
    expect(s.datamodel.sourceReachable).toBe(false);
    expect(s.datamodel.schemaRefined).toBe(false);
    expect(s.datamodel.mappingComplete).toBe(false);
    expect(s.datamodel.loadVerified).toBe(false);
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

describe("planStateToSignals — datamodel signals emitted", () => {
  it("emits all five datamodel signals as false when datamodel is empty", () => {
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
      datamodelArtifact: { modelInferred: true, schemaRefined: true },
    });
    const sig = planStateToSignals(s);
    expect(sig.modelInferred).toBe(true);
    expect(sig.schemaRefined).toBe(true);
    expect(sig.sourceReachable).toBe(false);
  });

  it("emits the full set when all artifact fields are true", () => {
    const s = derivePlanStageState({
      ...BASE_INPUT,
      datamodelArtifact: {
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

  it("preserves existing signals alongside new datamodel signals", () => {
    const s = derivePlanStageState({
      ...BASE_INPUT,
      repoCount: 2,
      datamodelArtifact: { modelInferred: true },
    });
    const sig = planStateToSignals(s);
    expect(sig.repoCount).toBe(2);
    expect(sig.modelInferred).toBe(true);
  });
});
