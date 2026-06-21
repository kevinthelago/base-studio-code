import { describe, it, expect } from "vitest";
import { derivePlanStageState, planStateToSignals, type DerivePlanStageInput } from "./planStageDerive";

const BASE_INPUT: DerivePlanStageInput = {
  sections: [],
  contextManifest: [],
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

describe("derivePlanStageState — context manifest gate (#1019)", () => {
  const drafted = (k: string) => ({ k, state: "drafted" as const });
  const confirmedSection = (k: string) => ({ k, state: "confirmed" as const });

  it("does NOT pass with an empty manifest (no required topics ⇒ stage can't auto-pass)", () => {
    const s = derivePlanStageState({ ...BASE_INPUT, sections: [confirmedSection("goal")] });
    expect(s.context.requiredContextConfirmed).toBe(false);
    expect(s.context.total).toBe(0);
  });

  it("requires every required topic present AND confirmed", () => {
    const manifest = [
      { topic: "goal", required: true, confirmed: true },
      { topic: "scope", required: true, confirmed: false }, // present but not confirmed
    ];
    const s = derivePlanStageState({
      ...BASE_INPUT,
      contextManifest: manifest,
      sections: [drafted("goal"), drafted("scope")],
    });
    expect(s.context.total).toBe(2);
    expect(s.context.resolved).toBe(1);
    expect(s.context.requiredContextConfirmed).toBe(false);
  });

  it("passes once all required topics are present and confirmed; ignores optional topics", () => {
    const manifest = [
      { topic: "goal", required: true, confirmed: true },
      { topic: "users", required: true, confirmed: true },
      { topic: "ux", required: false, confirmed: false }, // optional ⇒ doesn't gate
    ];
    const s = derivePlanStageState({
      ...BASE_INPUT,
      contextManifest: manifest,
      sections: [confirmedSection("goal"), confirmedSection("users")],
    });
    expect(s.context.requiredContextConfirmed).toBe(true);
    expect(planStateToSignals(s).requiredContextConfirmed).toBe(true);
  });

  it("a confirmed-but-absent required topic does NOT pass (file must exist)", () => {
    const manifest = [{ topic: "goal", required: true, confirmed: true }];
    const s = derivePlanStageState({ ...BASE_INPUT, contextManifest: manifest, sections: [] });
    expect(s.context.requiredContextConfirmed).toBe(false);
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
