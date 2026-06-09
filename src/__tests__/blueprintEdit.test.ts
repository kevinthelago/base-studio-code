import { describe, it, expect } from "vitest";
import {
  mkStageSection, mkEditorPipeline, reorderStages, addStage, duplicateStage, deleteStage,
  toggleDep, addPipeline, updatePipeline, removePipeline, setOutput, setStageField, depCandidates,
} from "../screens/projects/blueprintEdit";
import { STAGE_KINDS, DISPOSITIONS, pipelineMeta, defaultDisposition } from "../screens/projects/blueprintCatalog";
import { SECTION_DEFS } from "../screens/projects/blueprints";

describe("blueprintCatalog (#609)", () => {
  it("uses our `ui` key (not the design's `ux`)", () => {
    expect(STAGE_KINDS.ui).toBeTruthy();
    expect((STAGE_KINDS as Record<string, unknown>).ux).toBeUndefined();
  });
  it("default dispositions map sensibly and exist", () => {
    expect(defaultDisposition("structure")).toBe("issues");
    expect(defaultDisposition("skills")).toBe("skill-index");
    expect(defaultDisposition("context")).toBe("knowledge");
    expect(defaultDisposition("stack")).toBe("plan-file");
    for (const k of ["issues", "skill-index", "knowledge", "plan-file"]) expect(DISPOSITIONS[k]).toBeTruthy();
  });
  it("pipeline meta falls back for unknown ids", () => {
    expect(pipelineMeta("render-preview").gateable).toBe(true);
    expect(pipelineMeta("nope").glyph).toBe("conveyor_belt");
  });
});

describe("blueprintEdit — mkStageSection (#609)", () => {
  it("known kind keeps its runtime gate (from SECTION_DEFS) + gets a default output", () => {
    const s = mkStageSection("structure");
    expect(s.key).toBe("structure");
    expect(s.gateRule).toEqual(SECTION_DEFS.structure.gateRule); // runtime preserved
    expect(s.output).toBe("issues");
  });
  it("unknown kind is synthesized as an informational stage", () => {
    const s = mkStageSection("stack");
    expect(s.key).toBe("stack");
    expect(s.name).toBe(STAGE_KINDS.stack.title);
    expect(s.gateRule).toBeUndefined(); // informational — no runtime gate
    expect(s.output).toBe("plan-file");
    expect(s.pipelines).toEqual([]);
  });
});

describe("blueprintEdit — stage ops (#609)", () => {
  const base = () => [mkStageSection("context"), mkStageSection("ui"), mkStageSection("structure")];

  it("reorderStages moves by index; out-of-range is a no-op", () => {
    const a = base();
    expect(reorderStages(a, 0, 2).map((s) => s.key)).toEqual(["ui", "structure", "context"]);
    expect(reorderStages(a, 0, 9)).toBe(a);
  });

  it("addStage appends a fresh stage", () => {
    expect(addStage(base(), "permissions").map((s) => s.key)).toEqual(["context", "ui", "structure", "permissions"]);
  });

  it("duplicateStage inserts a fresh-uid copy after the original", () => {
    const a = base();
    const out = duplicateStage(a, a[1].uid);
    expect(out.map((s) => s.key)).toEqual(["context", "ui", "ui", "structure"]);
    expect(out[2].uid).not.toBe(a[1].uid);
    expect(out[2].name).toBe(a[1].name + " copy");
  });

  it("deleteStage removes it and scrubs deps by key when no twin remains", () => {
    // informational kinds start with empty deps (known kinds carry SECTION_DEFS deps).
    let a = [mkStageSection("context"), mkStageSection("stack"), mkStageSection("docs")];
    a = toggleDep(a, a[2].uid, "stack"); // docs depends on stack
    expect(a[2].deps).toContain("stack");
    const out = deleteStage(a, a[1].uid); // delete stack
    expect(out.map((s) => s.key)).toEqual(["context", "docs"]);
    expect(out.find((s) => s.key === "docs")!.deps).not.toContain("stack");
  });

  it("toggleDep adds then removes", () => {
    const a = [mkStageSection("context"), mkStageSection("stack")]; // empty deps
    const on = toggleDep(a, a[1].uid, "context");
    expect(on[1].deps).toContain("context");
    expect(toggleDep(on, a[1].uid, "context")[1].deps).not.toContain("context");
  });

  it("pipeline add/update/remove", () => {
    let a = base();
    a = addPipeline(a, a[1].uid, "render-preview");
    const p = a[1].pipelines[0];
    expect(p.id).toBe("render-preview");
    expect(p.trigger).toBe(pipelineMeta("render-preview").defaultTrigger);
    a = updatePipeline(a, a[1].uid, p.uid, { gate: true, trigger: "manual" });
    expect(a[1].pipelines[0].gate).toBe(true);
    expect(a[1].pipelines[0].trigger).toBe("manual");
    a = removePipeline(a, a[1].uid, p.uid);
    expect(a[1].pipelines).toHaveLength(0);
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
    expect(depCandidates(a, a[2].uid).map((s) => s.key)).toEqual(["context", "ui"]);
  });

  it("mkEditorPipeline pulls catalog name + default trigger", () => {
    const p = mkEditorPipeline("generate-issues");
    expect(p.name).toBe("Generate issues");
    expect(p.enabled).toBe(true);
    expect(p.gate).toBe(false);
  });
});
