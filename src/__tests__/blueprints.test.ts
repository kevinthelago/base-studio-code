import { describe, it, expect } from "vitest";
import {
  makeBlueprints, mkSection, computeStatus, reorder, cloneSections, blueprintToStageConfig,
  sectionStatus, incompleteSections, planSectionsComplete, currentSection, confirmedSignal,
  PIPELINE_LIB, SECTION_DEFS, type BlueprintSection,
} from "../screens/projects/blueprints";
import { PLAN_STAGES, buildPlanStageState } from "../screens/projects/planStages";
import { planStateToSignals } from "../screens/projects/planStageDerive";

const sig = (over: Parameters<typeof buildPlanStageState>[0] = {}) =>
  planStateToSignals(buildPlanStageState(over));
const setEnabled = (secs: BlueprintSection[], key: string, enabled: boolean): BlueprintSection[] =>
  secs.map((s) => (s.key === key ? { ...s, enabled } : s));

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
});

describe("blueprints — section status (declarative, blueprint-driven gates)", () => {
  // structure depends on context+repos+ui; build a set where those are satisfiable.
  const baseSecs = () => [
    mkSection("context"), mkSection("repos"), mkSection("ui"), mkSection("structure"),
    mkSection("permissions"), mkSection("skills"),
  ];
  const doneCtx = { context: { resolved: 1, total: 1, coreConfirmed: true }, repoCount: 1, requiresUi: false };

  it("evaluates a section's own declarative gate (not a hardcoded enum)", () => {
    const secs = baseSecs();
    const repos = secs.find((s) => s.key === "repos")!;
    expect(sectionStatus(repos, secs, sig({ repoCount: 0 })).status).toBe("in-progress");
    expect(sectionStatus(repos, secs, sig({ repoCount: 2 })).status).toBe("complete");
  });

  it("UI section is N/A when the project needs no UI (appliesWhen)", () => {
    const secs = baseSecs();
    const ui = secs.find((s) => s.key === "ui")!;
    expect(sectionStatus(ui, secs, sig({ requiresUi: false })).status).toBe("na");
  });

  it("locks a section whose enabled dependency is incomplete", () => {
    const secs = baseSecs();
    const structure = secs.find((s) => s.key === "structure")!;
    // context not confirmed → structure locked
    expect(sectionStatus(structure, secs, sig({ requiresUi: false })).status).toBe("locked");
  });

  it("a gateless (informational) section completes only when confirmed, not vacuously (#664)", () => {
    const secs = [mkSection("context"), mkSection("testing")];
    const testing = secs.find((s) => s.key === "testing")!;
    // not vacuously complete on a fresh/cleared plan
    expect(sectionStatus(testing, secs, sig()).status).toBe("in-progress");
    // complete once the section is confirmed
    expect(sectionStatus(testing, secs, { ...sig(), [confirmedSignal("testing")]: true }).status).toBe("complete");
  });

  it("an optional section is shown but never blocks completion, deps, or the current stage (#676)", () => {
    const secs = [mkSection("context"), mkSection("ui", { optional: true }), mkSection("structure")];
    const signals = sig({ context: { resolved: 1, total: 1, coreConfirmed: true }, requiresUi: true,
      phasesConfirmed: true, issueCount: 1 });
    const ui = secs.find((s) => s.key === "ui")!;
    // shown (not N/A) even though its screens gate is unmet
    expect(sectionStatus(ui, secs, signals).status).not.toBe("na");
    // off the critical path — never the current stage
    expect(currentSection(secs, signals)?.key).not.toBe("ui");
    // structure depends on ui, but optional ui doesn't lock it
    expect(sectionStatus(secs.find((s) => s.key === "structure")!, secs, signals).status).not.toBe("locked");
    // the incomplete optional ui doesn't block plan completion
    expect(planSectionsComplete([mkSection("context"), mkSection("ui", { optional: true })],
      sig({ context: { resolved: 1, total: 1, coreConfirmed: true }, requiresUi: true }))).toBe(true);
  });

  it("incompleteSections lists each unfinished section with its gate reason", () => {
    const secs = baseSecs();
    const inc = incompleteSections(secs, sig({ requiresUi: false }));
    const ctx = inc.find((i) => i.key === "context");
    expect(ctx?.reason).toBe(SECTION_DEFS.context.gate);
    // ui is N/A here, so it must not appear
    expect(inc.some((i) => i.key === "ui")).toBe(false);
  });

  it("planSectionsComplete is true only when every enabled, applicable section is done", () => {
    const secs = setEnabled(baseSecs(), "ui", false); // drop ui to simplify
    expect(planSectionsComplete(secs, sig(doneCtx))).toBe(false); // structure/permissions/skills unmet
    const allDone = {
      ...doneCtx, phasesConfirmed: true, issueCount: 3,
      fleet: { streams: 2, profilesComplete: true }, skillsAck: true,
    };
    expect(planSectionsComplete(secs, sig(allDone))).toBe(true);
  });

  it("currentSection is the first in-progress section, skipping N/A", () => {
    const secs = baseSecs();
    // context complete, repos incomplete, ui N/A → repos is the frontier
    const s = sig({ context: { resolved: 1, total: 1, coreConfirmed: true }, repoCount: 0, requiresUi: false });
    expect(currentSection(secs, s)?.key).toBe("repos");
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
