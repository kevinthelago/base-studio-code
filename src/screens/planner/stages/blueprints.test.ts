import { describe, it, expect } from "vitest";
import {
  makeBlueprints, mkSection, computeStatus, reorder, cloneSections, blueprintToStageConfig,
  sectionStatus, incompleteSections, planSectionsComplete, currentSection, confirmedSignal, skippedSignal,
  isAuthoringBlueprint, authoringSignals, canChangeBlueprint, canSwitchBlueprint, sectionDone,
  SECTION_DEFS, type BlueprintSection, type Blueprint,
} from "./blueprints";
import { PLAN_STAGES, buildPlanStageState } from "./planStages";
import { planStateToSignals } from "./planStageDerive";
import { evalGate } from "./stageGate";

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

  it("orders Features before UI in every UI-bearing blueprint (#825)", () => {
    for (const bp of makeBlueprints()) {
      const keys = bp.sections.map((s) => s.key);
      const ui = keys.indexOf("ui");
      if (ui < 0) continue; // headless blueprints have no UI stage
      const features = keys.indexOf("features");
      expect(features, `${bp.id}: features must precede ui`).toBeGreaterThanOrEqual(0);
      expect(features).toBeLessThan(ui);
    }
    // and the UI stage declares the features dependency that enforces it
    expect(SECTION_DEFS.ui.deps).toContain("features");
  });

  it("adds an optional MCP Servers stage after Permissions in the Complete blueprint (#878/#1003)", () => {
    expect(SECTION_DEFS.mcp).toBeTruthy();
    expect(SECTION_DEFS.mcp.optional).toBe(true);
    // #1003: the advanced stages moved off Default onto the Complete greenfield blueprint.
    for (const id of ["complete"]) {
      const bp = makeBlueprints().find((b) => b.id === id)!;
      const keys = bp.sections.map((s) => s.key);
      expect(keys, `${id} has an mcp stage`).toContain("mcp");
      expect(keys.indexOf("mcp"), `${id}: mcp after permissions`).toBeGreaterThan(keys.indexOf("permissions"));
    }
  });

  it("keeps the Default blueprint minimal; the advanced stages live on Complete (#1003)", () => {
    const bp = (id: string) => makeBlueprints().find((b) => b.id === id)!;
    const keysOf = (id: string) => bp(id).sections.map((s) => s.key);
    // Default is the simplest greenfield path — no source/mcp/automations/skills.
    expect(keysOf("default")).toEqual(["context", "repos", "deploy", "features", "ui", "structure", "permissions"]);
    for (const k of ["source", "mcp", "automations", "skills"]) {
      expect(keysOf("default"), `default omits ${k}`).not.toContain(k);
    }
    // Complete is the thorough greenfield path — the trimmed Default flow plus the advanced stages.
    const complete = keysOf("complete");
    expect(complete.slice(0, 7)).toEqual(["context", "repos", "deploy", "features", "ui", "structure", "permissions"]);
    for (const k of ["mcp", "automations", "skills"]) {
      expect(complete, `complete includes ${k}`).toContain(k);
    }
    // Complete sorts right after Default in the greenfield group.
    const greenfield = makeBlueprints().filter((b) => b.category === "greenfield").map((b) => b.id);
    expect(greenfield.indexOf("complete")).toBe(greenfield.indexOf("default") + 1);
  });

  it("includes a 'blueprint-author' authoring blueprint: deliverable=blueprint, 4 stages, no fleet/triage (#923)", () => {
    const bp = makeBlueprints().find((b) => b.id === "blueprint-author");
    expect(bp).toBeTruthy();
    expect(isAuthoringBlueprint(bp)).toBe(true);
    expect(bp!.deliverable).toBe("blueprint");
    const keys = bp!.sections.map((s) => s.key);
    expect(keys).toEqual(["purpose", "bp_stages", "bp_capabilities", "bp_review"]);
    // capabilities is the only optional stage; it has no repos/structure/permissions (no execution).
    expect(bp!.sections.find((s) => s.key === "bp_capabilities")!.optional).toBe(true);
    expect(keys).not.toContain("structure");
    expect(keys).not.toContain("permissions");
    // a normal blueprint is NOT an authoring one
    expect(isAuthoringBlueprint(makeBlueprints().find((b) => b.id === "default"))).toBe(false);
  });

  it("canChangeBlueprint: only greenfield projects can switch; others + blueprint-author locked (#923)", () => {
    const by = (id: string) => makeBlueprints().find((b) => b.id === id)!;
    expect(canChangeBlueprint(by("default"))).toBe(true);       // greenfield → switchable
    expect(canChangeBlueprint(by("refactor"))).toBe(false);     // transform → locked
    expect(canChangeBlueprint(by("harden"))).toBe(false);       // harden → locked
    expect(canChangeBlueprint(by("blueprint-author"))).toBe(false); // authoring → locked
  });

  it("canSwitchBlueprint: greenfield → transform | harden | maintain (#923)", () => {
    const by = (id: string) => makeBlueprints().find((b) => b.id === id)!;
    // a maintain-category blueprint (no built-in yet — synthesize from an existing one)
    const maintain = { ...by("harden"), id: "maint", category: "maintain" as const };
    // greenfield can move on to transform, harden, or maintain
    expect(canSwitchBlueprint(by("default"), by("refactor"))).toBe(true);   // → transform
    expect(canSwitchBlueprint(by("default"), by("harden"))).toBe(true);     // → harden
    expect(canSwitchBlueprint(by("default"), maintain)).toBe(true);         // → maintain
    // greenfield → another greenfield / data / itself is NOT allowed
    expect(canSwitchBlueprint(by("default"), by("mcp-server"))).toBe(false); // → greenfield
    expect(canSwitchBlueprint(by("default"), by("data-migration"))).toBe(false); // → data
    // a non-greenfield origin can't switch at all
    expect(canSwitchBlueprint(by("refactor"), by("harden"))).toBe(false);
    // anything touching the authoring lifecycle is refused
    expect(canSwitchBlueprint(by("blueprint-author"), by("refactor"))).toBe(false);
    expect(canSwitchBlueprint(by("default"), by("blueprint-author"))).toBe(false);
    // unbound (no current) can't "switch"
    expect(canSwitchBlueprint(undefined, by("refactor"))).toBe(false);
  });

  it("authoringSignals: identity (name+pitch+tag), stages (≥2 + prompts), publishable (#923)", () => {
    expect(authoringSignals(undefined)).toEqual({ bpName: false, bpStageCount: 0, bpStagesReady: false, bpValid: false });
    // identity needs name + pitch + ≥1 tag — name alone isn't enough.
    const named = { id: "x", name: "My BP", desc: "", sections: [] } as Blueprint;
    expect(authoringSignals(named)).toMatchObject({ bpName: false, bpValid: false });
    const identity = { id: "x", name: "My BP", desc: "", pitch: "ship it", tags: ["api"], sections: [] } as Blueprint;
    // identity passes, but no stages → not ready / not publishable.
    expect(authoringSignals(identity)).toMatchObject({ bpName: true, bpStagesReady: false, bpValid: false });
    // ≥2 stages but a stage missing its prompt → stages gate fails.
    const oneEmptyPrompt = {
      ...identity,
      sections: [{ ...mkSection("purpose"), prompt: "do x" }, { ...mkSection("bp_stages"), prompt: "" }],
    } as Blueprint;
    expect(authoringSignals(oneEmptyPrompt)).toMatchObject({ bpStageCount: 2, bpStagesReady: false, bpValid: false });
    // identity + ≥2 stages all with prompts → ready + publishable.
    const full = {
      ...identity,
      sections: [{ ...mkSection("purpose"), prompt: "do x" }, { ...mkSection("bp_stages"), prompt: "do y" }],
    } as Blueprint;
    expect(authoringSignals(full)).toMatchObject({ bpName: true, bpStageCount: 2, bpStagesReady: true, bpValid: true });
  });

  it("includes a headless 'mcp-server' greenfield blueprint with no UI stage (#825)", () => {
    const mcp = makeBlueprints().find((b) => b.id === "mcp-server");
    expect(mcp).toBeTruthy();
    expect(mcp!.category).toBe("greenfield");
    const keys = mcp!.sections.map((s) => s.key);
    expect(keys).not.toContain("ui");
    expect(keys).toContain("features");
    expect(keys).toContain("structure");
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

  it("cloneSections gives fresh uids", () => {
    const src = [mkSection("ui")];
    const copy = cloneSections(src);
    expect(copy[0].uid).not.toBe(src[0].uid);
    expect(copy[0].key).toBe("ui");
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

  it("an optional stage is shown + never locks dependents, but IS a deliberate stop the user must decide (#676/#921)", () => {
    const secs = [mkSection("context"), mkSection("ui", { optional: true }), mkSection("structure")];
    const signals = sig({ context: { resolved: 1, total: 1, coreConfirmed: true }, requiresUi: true,
      phasesConfirmed: true, issueCount: 1 });
    const ui = secs.find((s) => s.key === "ui")!;
    // shown (not N/A) even though its screens gate is unmet
    expect(sectionStatus(ui, secs, signals).status).not.toBe("na");
    // structure depends on ui, but an optional dep never locks the dependent (#676)
    expect(sectionStatus(secs.find((s) => s.key === "structure")!, secs, signals).status).not.toBe("locked");
    // #921: the flow now STOPS on the optional stage — once context is done it IS the current stage,
    // so the user decides whether to do or skip it (was: optional excluded from the frontier).
    expect(currentSection(secs, signals)?.key).toBe("ui");
    // …and an undecided optional stage blocks plan completion until the user decides (do or skip).
    const twoSec = [mkSection("context"), mkSection("ui", { optional: true })];
    const ctxDone = sig({ context: { resolved: 1, total: 1, coreConfirmed: true }, requiresUi: true });
    expect(planSectionsComplete(twoSec, ctxDone)).toBe(false);
    // a USER-skip resolves the optional stage → it counts as done, the frontier advances, plan completes.
    const skipped = { ...ctxDone, [skippedSignal("ui")]: true };
    expect(sectionDone(ui, skipped).done).toBe(true);
    expect(currentSection(twoSec, skipped)?.key).toBe("ui"); // last applicable once all resolved
    expect(planSectionsComplete(twoSec, skipped)).toBe(true);
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
      ...doneCtx, phasesConfirmed: true,
      fleet: { streams: 2, profilesComplete: true }, skillsAck: true,
    };
    // featuresPhased is an extra signal (added in Planning.tsx alongside hasPlanGaps), not part of
    // planStateToSignals — supply it the same way the app does (#plan-db).
    expect(planSectionsComplete(secs, { ...sig(allDone), featuresPhased: true })).toBe(true);
  });

  it("currentSection is the first in-progress section, skipping N/A", () => {
    const secs = baseSecs();
    // context complete, repos incomplete, ui N/A → repos is the frontier
    const s = sig({ context: { resolved: 1, total: 1, coreConfirmed: true }, repoCount: 0, requiresUi: false });
    expect(currentSection(secs, s)?.key).toBe("repos");
  });

  it("blueprintToStageConfig maps enabled+order over known stages, dropping non-registry sections", () => {
    const known = new Set(PLAN_STAGES.map((s) => s.id));
    // a blueprint including "testing" (a non-registry stage) — dropped from the stage config order.
    const bp = { id: "t", name: "T", desc: "", sections: [mkSection("context"), mkSection("repos"), mkSection("structure"), mkSection("testing")] } as Blueprint;
    const cfg = blueprintToStageConfig(bp);
    // order only contains registry stage ids, in blueprint order
    expect(cfg.order.every((id) => known.has(id))).toBe(true);
    expect(cfg.order).not.toContain("testing" as never);
    // a section's enabled flag carries through
    const repos = bp.sections.find((s) => s.key === "repos")!;
    expect(cfg.enabled.repos).toBe(repos.enabled);
  });
});

describe("lint-as-gate (#897 Phase 4b)", () => {
  it("wires a hasPlanGaps requirement into the context + structure gates", () => {
    for (const key of ["context", "structure"] as const) {
      const reqs = SECTION_DEFS[key].gateRule?.require ?? [];
      const r = reqs.find((x) => x.signal === "hasPlanGaps");
      expect(r, `${key} has a hasPlanGaps requirement`).toBeTruthy();
      expect(r!.target).toBe(false); // must be FALSE (no gaps) to pass
      expect(r!.weight).toBe(0);     // must-pass, doesn't move the progress fill
    }
  });

  it("blocks the gate on an unresolved placeholder, passes when clean or absent (absent-safe)", () => {
    const gate = SECTION_DEFS.context.gateRule!;
    const base = { coreConfirmed: true, topicsResolved: 3, topicsTotal: 3 }; // other context reqs satisfied
    expect(evalGate(gate, { ...base, hasPlanGaps: true }).done).toBe(false);  // a TODO/placeholder blocks
    expect(evalGate(gate, { ...base, hasPlanGaps: false }).done).toBe(true);  // clean passes
    expect(evalGate(gate, base).done).toBe(true);                             // signal absent ⇒ passes
  });
});
