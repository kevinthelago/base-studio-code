import { describe, it, expect } from "vitest";
import {
  makeBlueprints, mkSection, computeStatus, reorder, cloneSections, blueprintToStageConfig,
  PIPELINE_LIB, SECTION_DEFS,
} from "../screens/projects/blueprints";
import { PLAN_STAGES } from "../screens/projects/planStages";

describe("blueprints — seed library", () => {
  it("seeds the starter blueprints with a 'default'", () => {
    const bps = makeBlueprints();
    expect(bps.find((b) => b.id === "default")).toBeTruthy();
    expect(bps.length).toBeGreaterThanOrEqual(4);
  });

  it("each section carries a prompt module and a gate from its def", () => {
    const ctx = makeBlueprints()[0].sections.find((s) => s.key === "context")!;
    expect(ctx.prompt.length).toBeGreaterThan(20);
    expect(ctx.gate).toBe(SECTION_DEFS.context.gate);
  });

  it("mkSection resolves pipeline ids against the catalog", () => {
    const ui = mkSection("ui", { pipelines: [["render-preview", "on artifact change", true]] });
    expect(ui.pipelines).toHaveLength(1);
    expect(ui.pipelines[0].name).toBe(PIPELINE_LIB.find((p) => p.id === "render-preview")!.name);
    expect(ui.pipelines[0].trigger).toBe("on artifact change");
  });
});

describe("blueprints — computeStatus (dependency locks)", () => {
  it("locks a section whose enabled dependency is disabled", () => {
    // structure depends on context, repos, ui; disable repos -> structure locked.
    const secs = [mkSection("context"), mkSection("repos", { enabled: false }), mkSection("ui"), mkSection("structure")];
    const st = computeStatus(secs);
    expect(st.structure.locked).toBe(true);
    expect(st.structure.unmet).toContain("repos");
  });

  it("a dependency omitted from the blueprint is treated as met", () => {
    // structure present but ui omitted entirely -> ui not counted as unmet.
    const secs = [mkSection("context"), mkSection("repos"), mkSection("structure")];
    const st = computeStatus(secs);
    expect(st.structure.unmet).not.toContain("ui");
    expect(st.structure.locked).toBe(false);
  });

  it("all deps enabled -> not locked, satisfied", () => {
    const secs = [mkSection("context"), mkSection("repos"), mkSection("ui"), mkSection("structure")];
    const st = computeStatus(secs);
    expect(st.structure.locked).toBe(false);
    expect(st.structure.satisfied).toBe(true);
  });
});

describe("blueprints — helpers", () => {
  it("reorder moves an item before/after a target by uid", () => {
    const a = [{ uid: "x" }, { uid: "y" }, { uid: "z" }];
    expect(reorder(a, "z", "x", true).map((o) => o.uid)).toEqual(["z", "x", "y"]);
    expect(reorder(a, "x", "z", false).map((o) => o.uid)).toEqual(["y", "z", "x"]);
  });

  it("cloneSections gives fresh uids and independent pipelines", () => {
    const src = [mkSection("ui", { pipelines: [["render-preview", "on completion", true]] })];
    const copy = cloneSections(src);
    expect(copy[0].uid).not.toBe(src[0].uid);
    expect(copy[0].pipelines[0].uid).not.toBe(src[0].pipelines[0].uid);
  });

  it("blueprintToStageConfig maps enabled+order over known stages, dropping non-registry sections", () => {
    const known = new Set(PLAN_STAGES.map((s) => s.id));
    const bp = makeBlueprints().find((b) => b.id === "fullstack")!; // includes "testing"
    const cfg = blueprintToStageConfig(bp);
    // order only contains registry stage ids, in blueprint order
    expect(cfg.order.every((id) => known.has(id))).toBe(true);
    expect(cfg.order).not.toContain("testing" as never);
    // a section's enabled flag carries through
    const repos = bp.sections.find((s) => s.key === "repos")!;
    expect(cfg.enabled.repos).toBe(repos.enabled);
  });
});
