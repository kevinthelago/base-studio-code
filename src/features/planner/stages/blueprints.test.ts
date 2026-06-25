import { describe, it, expect } from "vitest";
import {
  makeBlueprints, mkSection, computeStatus, reorder, cloneSections, blueprintToStageConfig,
  sectionStatus, incompleteSections, planSectionsComplete, currentSection, confirmedSignal, skippedSignal,
  isAuthoringBlueprint, authoringSignals, canChangeBlueprint, canSwitchBlueprint, sectionDone,
  signatureTemplateVersion, blueprintTemplateChanged, shouldAutoOpenBlueprintModal,
  SECTION_DEFS, type BlueprintSection, type Blueprint,
} from "./blueprints";
import { SKILLS } from "@/shared/data/skills";
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
    // Default is the simplest greenfield path — no source/mcp/automations/skills. Deploy is folded
    // into the `repos` stage as a ship substep (#1383), so it's no longer a separate section key.
    expect(keysOf("default")).toEqual(["context", "repos", "features", "ui", "structure", "permissions"]);
    for (const k of ["source", "mcp", "automations", "skills", "deploy"]) {
      expect(keysOf("default"), `default omits ${k}`).not.toContain(k);
    }
    // Complete is the thorough greenfield path — the trimmed Default flow plus source + the advanced stages.
    expect(keysOf("complete")).toEqual(
      ["context", "repos", "source", "features", "ui", "structure", "permissions", "mcp", "automations", "skills"],
    );
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

  it("canChangeBlueprint: any project blueprint can switch; only the blueprint-author lifecycle is locked (#1281)", () => {
    const by = (id: string) => makeBlueprints().find((b) => b.id === id)!;
    expect(canChangeBlueprint(by("default"))).toBe(true);           // greenfield → switchable
    expect(canChangeBlueprint(by("refactor"))).toBe(true);          // transform → switchable (was locked)
    expect(canChangeBlueprint(by("harden"))).toBe(true);            // harden → switchable (was locked)
    expect(canChangeBlueprint(by("blueprint-author"))).toBe(false); // authoring → locked
  });

  it("canSwitchBlueprint: any project blueprint → any OTHER, except authoring + self (#1281)", () => {
    const by = (id: string) => makeBlueprints().find((b) => b.id === id)!;
    // greenfield → transform / harden — still allowed
    expect(canSwitchBlueprint(by("default"), by("refactor"))).toBe(true);        // → transform
    expect(canSwitchBlueprint(by("default"), by("harden"))).toBe(true);          // → harden
    // previously-refused targets are now allowed (the over-restriction is gone)
    expect(canSwitchBlueprint(by("default"), by("complete"))).toBe(true);        // → another greenfield
    expect(canSwitchBlueprint(by("default"), by("data-migration"))).toBe(true);  // → data
    // a non-greenfield origin can switch now — no more soft-lock (the #1281 bug)
    expect(canSwitchBlueprint(by("refactor"), by("harden"))).toBe(true);
    expect(canSwitchBlueprint(by("refactor"), by("default"))).toBe(true);        // transform → back to greenfield
    // refused: switching to the SAME blueprint (a no-op)
    expect(canSwitchBlueprint(by("default"), by("default"))).toBe(false);
    // refused: anything touching the authoring lifecycle
    expect(canSwitchBlueprint(by("blueprint-author"), by("refactor"))).toBe(false);
    expect(canSwitchBlueprint(by("default"), by("blueprint-author"))).toBe(false);
    // refused: unbound (no current) can't "switch"
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
  const doneCtx = { context: { resolved: 1, total: 1, requiredContextReady: true }, repoCount: 1, requiresUi: false };

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
    const signals = sig({ context: { resolved: 1, total: 1, requiredContextReady: true }, requiresUi: true,
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
    const ctxDone = sig({ context: { resolved: 1, total: 1, requiredContextReady: true }, requiresUi: true });
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
    const s = sig({ context: { resolved: 1, total: 1, requiredContextReady: true }, repoCount: 0, requiresUi: false });
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
    const base = { requiredContextReady: true, topicsResolved: 3, topicsTotal: 3 }; // other context reqs satisfied
    expect(evalGate(gate, { ...base, hasPlanGaps: true }).done).toBe(false);  // a TODO/placeholder blocks
    expect(evalGate(gate, { ...base, hasPlanGaps: false }).done).toBe(true);  // clean passes
    expect(evalGate(gate, base).done).toBe(true);                             // signal absent ⇒ passes
  });
});

describe("Deploy folds in dependencies (#1127)", () => {
  it("has no standalone dependencies section anymore", () => {
    expect(SECTION_DEFS.dependencies).toBeUndefined();
    expect(makeBlueprints().find((b) => b.id === "default")!.sections.map((s) => s.key)).not.toContain("dependencies");
  });

  it("requires BOTH shipping and a locked dependency before Deploy passes", () => {
    const gate = SECTION_DEFS.deploy.gateRule!;
    const signals = gate.require.map((r) => r.signal);
    expect(signals).toContain("deploymentDefined");
    expect(signals).toContain("dependenciesDefined");
    expect(evalGate(gate, { deploymentDefined: true, dependenciesDefined: 0 }).done).toBe(false); // deps missing
    expect(evalGate(gate, { deploymentDefined: false, dependenciesDefined: 2 }).done).toBe(false); // shipping missing
    expect(evalGate(gate, { deploymentDefined: true, dependenciesDefined: 1 }).done).toBe(true);  // both ⇒ pass
  });

  it("folds Deploy into the Repos stage as a ship substep when a blueprint opts in (#1383)", () => {
    // ship:true → one "Repositories & Deployment" stage with link+ship substeps, and the gate is the
    // UNION (repos linked AND shipping+deps). Non-ship → plain Repos, repos-only gate, no substeps.
    const merged = mkSection("repos", { ship: true });
    expect(merged.name).toBe("Repositories & Deployment");
    expect(merged.substeps?.map((s) => s.key)).toEqual(["link", "ship"]);
    const sig = merged.gateRule!.require.map((r) => r.signal);
    expect(sig).toEqual(expect.arrayContaining(["repoCount", "deploymentDefined", "dependenciesDefined"]));
    // The merged gate needs repos AND shipping AND a dependency.
    expect(evalGate(merged.gateRule!, { repoCount: 1, deploymentDefined: false, dependenciesDefined: 0 }).done).toBe(false);
    expect(evalGate(merged.gateRule!, { repoCount: 1, deploymentDefined: true, dependenciesDefined: 1 }).done).toBe(true);

    const plain = mkSection("repos");
    expect(plain.name).toBe("Repos");
    expect(plain.substeps).toBeUndefined();
    expect(plain.gateRule!.require.map((r) => r.signal)).toEqual(["repoCount"]); // repos-only, unchanged
  });

  it("the greenfield blueprints opt repos into ship; data-integration keeps Deploy standalone (#1383)", () => {
    const reposRef = (id: string) => makeBlueprints().find((b) => b.id === id)!.sections.find((s) => s.key === "repos");
    // default + complete: repos carries the ship substep, no separate deploy section.
    for (const id of ["default", "complete"]) {
      expect(reposRef(id)?.substeps?.some((s) => s.key === "ship"), `${id} ships via repos`).toBe(true);
      expect(makeBlueprints().find((b) => b.id === id)!.sections.map((s) => s.key)).not.toContain("deploy");
    }
    // data-integration deploys without a repos stage → keeps Deploy as its own section (unchanged).
    const di = makeBlueprints().find((b) => b.id === "data-integration")!;
    expect(di.sections.map((s) => s.key)).toContain("deploy");
    expect(di.sections.find((s) => s.key === "repos")).toBeUndefined();
  });
});

describe("data-integration blueprint (#1207)", () => {
  const bp = () => makeBlueprints().find((b) => b.id === "data-integration")!;

  it("loads, categorized data / create, with the full extractor section order + Compliance MCP", () => {
    const b = bp();
    expect(b).toBeTruthy();
    expect(b.category).toBe("data");
    expect(b.mode).toBe("create");
    expect(b.sections.map((s) => s.key)).toEqual(
      ["context", "dataSource", "dataModel", "dataMap", "destination", "sync", "dataClean", "integrations", "structure", "permissions", "deploy"],
    );
    expect(b.mcp).toContain("Compliance"); // #1005 Compliance MCP attached
  });

  it("surfaces an optional, non-blocking Integrations stage (#1200)", () => {
    const intg = bp().sections.find((s) => s.key === "integrations")!;
    expect(intg).toBeTruthy();
    expect(intg.optional).toBe(true); // inherited from the section def — shown, never blocks
    expect(intg.gateRule).toBeUndefined(); // soft/informational, no gate signal
  });

  it("destination + sync sections gate on their own signals (#1207)", () => {
    const dest = SECTION_DEFS.destination.gateRule!;
    expect(dest.require.map((r) => r.signal)).toContain("destinationDefined");
    expect(evalGate(dest, { destinationDefined: false }).done).toBe(false);
    expect(evalGate(dest, { destinationDefined: true }).done).toBe(true);

    const sync = SECTION_DEFS.sync.gateRule!;
    expect(sync.require.map((r) => r.signal)).toContain("syncDefined");
    expect(evalGate(sync, { syncDefined: false }).done).toBe(false);
    expect(evalGate(sync, { syncDefined: true }).done).toBe(true);
  });

  it("sync depends on destination — locks until the destination is defined", () => {
    const secs = [mkSection("context"), mkSection("destination"), mkSection("sync")];
    const sync = secs.find((s) => s.key === "sync")!;
    const ctxDone = sig({ context: { resolved: 1, total: 1, requiredContextReady: true }, repoCount: 1, requiresUi: false });
    // dep (destination) unmet + own gate unmet ⇒ locked
    expect(sectionStatus(sync, secs, { ...ctxDone, destinationDefined: false, syncDefined: false }).status).toBe("locked");
    // dep met, own gate still unmet ⇒ in-progress (unlocked)
    expect(sectionStatus(sync, secs, { ...ctxDone, destinationDefined: true, syncDefined: false }).status).toBe("in-progress");
    // own gate met ⇒ complete
    expect(sectionStatus(sync, secs, { ...ctxDone, destinationDefined: true, syncDefined: true }).status).toBe("complete");
  });
});

describe("Web SEO capability (#1293)", () => {
  it("ships a self-gating web-seo skill in the library", () => {
    const seo = SKILLS.find((s) => s.id === "web-seo");
    expect(seo, "web-seo skill present").toBeDefined();
    expect(seo!.profiles).toContain("build");
    // Self-gating: only applies to a public web surface.
    expect(seo!.body ?? "").toMatch(/SKIP|web surface|web-facing/i);
    expect(seo!.body ?? "").toMatch(/sitemap|robots|Open Graph|JSON-LD/i);
  });

  it("attaches web-seo to the greenfield web blueprints, not transform/data ones", () => {
    const by = (id: string) => makeBlueprints().find((b) => b.id === id)!;
    expect(by("default").skills).toContain("web-seo");
    expect(by("complete").skills).toContain("web-seo");
    // Not on a transform/data blueprint.
    expect(by("refactor").skills ?? []).not.toContain("web-seo");
    expect(by("data-migration").skills ?? []).not.toContain("web-seo");
  });

  it("every blueprint skill id resolves to a real library skill", () => {
    const ids = new Set(SKILLS.map((s) => s.id));
    for (const bp of makeBlueprints()) {
      for (const sid of bp.skills ?? []) {
        expect(ids.has(sid), `blueprint '${bp.id}' references unknown skill '${sid}'`).toBe(true);
      }
    }
  });
});

// Regression for #1296: the destructive "blueprint has changed" modal must auto-open ONLY on a
// genuine blueprint/planner-template version change — never on benign mid-project setup tweaks
// (linking a repo, toggling a KB block, enabling/disabling a stage), which merely change the
// repos/kb/stages fields of the context signature and should only drive the silent stale badge.
describe("blueprint-changed modal trigger (#1296)", () => {
  // Signature format mirrors planner/workspace.rs context_signature: v{ver}|repos|kb|stages.
  const sigFor = (ver: string, repos = "", kb = "", stages = "") => `v${ver}|${repos}|${kb}|${stages}`;

  it("signatureTemplateVersion extracts the version prefix (and tolerates empty/partial input)", () => {
    expect(signatureTemplateVersion("v7|a,b|k1|s1")).toBe("v7");
    expect(signatureTemplateVersion("v7")).toBe("v7"); // no inputs after the version
    expect(signatureTemplateVersion("")).toBe("");
    expect(signatureTemplateVersion(null)).toBe("");
    expect(signatureTemplateVersion(undefined)).toBe("");
  });

  it("blueprintTemplateChanged is false when only repos/kb/stages differ (benign setup tweak)", () => {
    const baseline = sigFor("7", "owner/a", "kb1", "goal");
    // Mid-project: linked a repo, toggled a KB block, enabled a stage — version unchanged.
    expect(blueprintTemplateChanged(sigFor("7", "owner/a,owner/b", "kb1", "goal"), baseline)).toBe(false);
    expect(blueprintTemplateChanged(sigFor("7", "owner/a", "", "goal"), baseline)).toBe(false);
    expect(blueprintTemplateChanged(sigFor("7", "owner/a", "kb1", "goal,scope"), baseline)).toBe(false);
  });

  it("blueprintTemplateChanged is true only when the template version differs", () => {
    const baseline = sigFor("7", "owner/a", "kb1", "goal");
    expect(blueprintTemplateChanged(sigFor("8", "owner/a", "kb1", "goal"), baseline)).toBe(true);
    // Empty/absent signatures never count as a change (avoids spurious open before sigs load).
    expect(blueprintTemplateChanged("", baseline)).toBe(false);
    expect(blueprintTemplateChanged(baseline, null)).toBe(false);
  });

  it("does NOT auto-open the modal on a benign setup tweak (the #1296 bug)", () => {
    const baseline = sigFor("7", "owner/a", "kb1", "goal");
    const afterRepoLink = sigFor("7", "owner/a,owner/b", "kb1", "goal");
    expect(shouldAutoOpenBlueprintModal({
      currentSig: afterRepoLink, baselineSig: baseline, hasExistingPlan: true, alreadyShown: false,
    })).toBe(false);
  });

  it("DOES auto-open the modal on a real blueprint/template-version change", () => {
    const baseline = sigFor("7", "owner/a", "kb1", "goal");
    const afterTemplateBump = sigFor("8", "owner/a", "kb1", "goal");
    expect(shouldAutoOpenBlueprintModal({
      currentSig: afterTemplateBump, baselineSig: baseline, hasExistingPlan: true, alreadyShown: false,
    })).toBe(true);
  });

  it("respects the existing-plan and once-per-open guards even on a real version change", () => {
    const baseline = sigFor("7", "owner/a", "kb1", "goal");
    const bumped = sigFor("8", "owner/a", "kb1", "goal");
    // No plan to protect → no modal.
    expect(shouldAutoOpenBlueprintModal({
      currentSig: bumped, baselineSig: baseline, hasExistingPlan: false, alreadyShown: false,
    })).toBe(false);
    // Already shown once this open → don't re-fire.
    expect(shouldAutoOpenBlueprintModal({
      currentSig: bumped, baselineSig: baseline, hasExistingPlan: true, alreadyShown: true,
    })).toBe(false);
  });
});
