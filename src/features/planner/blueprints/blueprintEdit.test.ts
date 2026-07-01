import { describe, it, expect } from "vitest";
import {
  mkStageSection, reorderStages, addStage, deleteStage,
  toggleDep, setOutput, setStageField, depCandidates,
} from "./blueprintEdit";
import { STAGE_KINDS, DISPOSITIONS, defaultDisposition } from "./blueprintCatalog";
import { STAGE_DEFS } from "../stages/blueprints";

describe("blueprintCatalog (#609)", () => {
  it("uses our `ui` key (not the design's `ux`)", () => {
    expect(STAGE_KINDS.ui).toBeTruthy();
    expect((STAGE_KINDS as Record<string, unknown>).ux).toBeUndefined();
  });
  it("default dispositions map sensibly and exist", () => {
    expect(defaultDisposition("streams")).toBe("issues");
    expect(defaultDisposition("skills")).toBe("skill-index");
    expect(defaultDisposition("discovery")).toBe("knowledge");
    expect(defaultDisposition("stack")).toBe("plan-file");
    for (const k of ["issues", "skill-index", "knowledge", "plan-file"]) expect(DISPOSITIONS[k]).toBeTruthy();
  });
});

describe("blueprintEdit — mkStageSection (#609)", () => {
  it("known kind keeps its runtime gate (from STAGE_DEFS) + gets a default output", () => {
    const s = mkStageSection("streams");
    expect(s.key).toBe("streams");
    expect(s.gateRule).toEqual(STAGE_DEFS.streams.gateRule); // runtime preserved
    expect(s.output).toBe("issues");
  });
  it("unknown kind is synthesized as an informational stage", () => {
    const s = mkStageSection("stack");
    expect(s.key).toBe("stack");
    expect(s.name).toBe(STAGE_KINDS.stack.title);
    expect(s.gateRule).toBeUndefined(); // informational — no runtime gate
    expect(s.output).toBe("plan-file");
  });
});

describe("blueprintEdit — stage ops (#609)", () => {
  const base = () => [mkStageSection("discovery"), mkStageSection("ui"), mkStageSection("streams")];

  it("reorderStages moves by index; out-of-range is a no-op", () => {
    const a = base();
    expect(reorderStages(a, 0, 2).map((s) => s.key)).toEqual(["ui", "streams", "discovery"]);
    expect(reorderStages(a, 0, 9)).toBe(a);
  });

  it("addStage appends a fresh stage", () => {
    expect(addStage(base(), "skills").map((s) => s.key)).toEqual(["discovery", "ui", "streams", "skills"]);
  });

  it("deleteStage removes it and scrubs deps by key when no twin remains", () => {
    // informational kinds start with empty deps (known kinds carry STAGE_DEFS deps).
    let a = [mkStageSection("discovery"), mkStageSection("stack"), mkStageSection("docs")];
    a = toggleDep(a, a[2].uid, "stack"); // docs depends on stack
    expect(a[2].deps).toContain("stack");
    const out = deleteStage(a, a[1].uid); // delete stack
    expect(out.map((s) => s.key)).toEqual(["discovery", "docs"]);
    expect(out.find((s) => s.key === "docs")!.deps).not.toContain("stack");
  });

  it("toggleDep adds then removes", () => {
    const a = [mkStageSection("discovery"), mkStageSection("stack")]; // empty deps
    const on = toggleDep(a, a[1].uid, "discovery");
    expect(on[1].deps).toContain("discovery");
    expect(toggleDep(on, a[1].uid, "discovery")[1].deps).not.toContain("discovery");
  });

  it("setOutput + setStageField", () => {
    let a = base();
    a = setOutput(a, a[0].uid, "scratch");
    expect(a[0].output).toBe("scratch");
    a = setStageField(a, a[0].uid, { name: "Kickoff", prompt: "hi" });
    expect(a[0].name).toBe("Kickoff");
    expect(a[0].prompt).toBe("hi");
  });

  it("depCandidates returns only earlier stages", () => {
    const a = base();
    expect(depCandidates(a, a[0].uid)).toEqual([]);
    expect(depCandidates(a, a[2].uid).map((s) => s.key)).toEqual(["discovery", "ui"]);
  });
});
