import { describe, it, expect } from "vitest";
import { SECTION_DEFS, makeBlueprints } from "./blueprints";

// #850 — the planner should propose the most complete, production-grade solution by
// default, not a truncated "starter" cut. The Features stage is where scope is set, so
// its prompt is the load-bearing place to assert the posture.
describe("Features stage posture (#850)", () => {
  const features = SECTION_DEFS.features;
  const propose = features.substeps?.find((s) => s.key === "propose");

  it("asks for the complete, production-grade capability set", () => {
    expect(propose).toBeDefined();
    const p = propose!.prompt.toLowerCase();
    expect(p).toContain("complete set");
    expect(p).toContain("production-grade");
  });

  it("does not default to a truncated 'starter / enough to get going' set", () => {
    const all = `${features.prompt} ${propose?.prompt ?? ""}`.toLowerCase();
    expect(all).not.toContain("starter set");
    expect(all).not.toContain("enough to get going");
  });

  it("keeps completeness separate from phasing (the user still sequences)", () => {
    // Completeness is about capabilities; the prompt must not pre-trim to a phase-1 slice.
    expect(propose!.prompt.toLowerCase()).toContain("phas");
  });
});

describe("greenfield source SECTION_DEF (pp-section)", () => {
  it("exists and is distinct from the standalone dataSource", () => {
    expect(SECTION_DEFS.source).toBeDefined();
    expect(SECTION_DEFS.dataSource).toBeDefined();
    expect(SECTION_DEFS.source).not.toBe(SECTION_DEFS.dataSource);
  });

  it("is marked optional (skippable via #676 mechanism)", () => {
    expect(SECTION_DEFS.source.optional).toBe(true);
  });

  it("gates on modelInferred and schemaRefined signals", () => {
    const signals = SECTION_DEFS.source.gateRule?.require.map((r) => r.signal) ?? [];
    expect(signals).toContain("modelInferred");
    expect(signals).toContain("schemaRefined");
  });

  it("depends on context and repos", () => {
    expect(SECTION_DEFS.source.deps).toContain("context");
    expect(SECTION_DEFS.source.deps).toContain("repos");
  });
});

describe("Default blueprint — source section placement (pp-section)", () => {
  it("includes the source section after repos and before features", () => {
    const bps = makeBlueprints();
    const def = bps.find((b) => b.id === "default")!;
    const keys = def.sections.map((s) => s.key);
    const reposIdx = keys.indexOf("repos");
    const sourceIdx = keys.indexOf("source");
    const featuresIdx = keys.indexOf("features");
    expect(sourceIdx).toBeGreaterThan(reposIdx);
    expect(sourceIdx).toBeLessThan(featuresIdx);
  });

  it("source section is optional in the Default blueprint", () => {
    const bps = makeBlueprints();
    const def = bps.find((b) => b.id === "default")!;
    const sourceSection = def.sections.find((s) => s.key === "source");
    expect(sourceSection?.optional).toBe(true);
  });
});

describe("data-migration and data-collection blueprints — byte-identical (pp-section)", () => {
  it("data-migration sections are unchanged by the greenfield source section", () => {
    const bps = makeBlueprints();
    const dm = bps.find((b) => b.id === "data-migration")!;
    expect(dm.sections.map((s) => s.key)).toEqual([
      "context", "dataSource", "dataModel", "dataMap", "dataClean", "dataLoad",
    ]);
  });

  it("data-collection sections are unchanged by the greenfield source section", () => {
    const bps = makeBlueprints();
    const dc = bps.find((b) => b.id === "data-collection")!;
    expect(dc.sections.map((s) => s.key)).toEqual([
      "context", "collectTargets", "dataModel", "sourceLicensing",
      "dataAcquire", "dataExtract", "dataClean", "dataLoad",
    ]);
  });
});
