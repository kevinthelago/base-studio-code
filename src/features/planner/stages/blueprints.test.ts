import { describe, it, expect } from "vitest";
import {
  makeBlueprints, mkStage, computeStatus, reorder, cloneStages, blueprintToStageConfig,
  stageStatus, incompleteStages, planStagesComplete, currentStage, confirmedSignal, skippedSignal,
  stageDone,
  signatureTemplateVersion, blueprintTemplateChanged, shouldAutoOpenBlueprintModal,
  dedupeSections, resolveStagePrompt, stageSeed,
  STAGE_DEFS, type BlueprintStage, type Blueprint, type SectionDef,
} from "./blueprints";
import { SKILLS } from "@/shared/data/skills";
import { PLAN_STAGES, buildPlanStageState } from "./planStages";
import { planStateToSignals } from "./planStageDerive";
import { evalGate } from "./stageGate";

const sig = (over: Parameters<typeof buildPlanStageState>[0] = {}) =>
  planStateToSignals(buildPlanStageState(over));
const setEnabled = (secs: BlueprintStage[], key: string, enabled: boolean): BlueprintStage[] =>
  secs.map((s) => (s.key === key ? { ...s, enabled } : s));

describe("greenfield blueprints declare their consumer kit (#2810)", () => {
  const bps = makeBlueprints();

  it("CREATE built-ins auto-record kit=react-ui so the kit_usage edge fills at bind (#3785)", () => {
    // …every create-from-a-pitch blueprint actually SHIPS an app UI. Keyed off `mode` since #3785
    // removed the lifecycle `category` this used to read.
    const create = bps.filter((b) => b.mode !== "operate");
    expect(create.length).toBeGreaterThan(0);
    expect(create.every((b) => b.kit === "react-ui")).toBe(true);
  });

  it("an OPERATE-on-existing-repos built-in isn't auto-tied to a shared kit", () => {
    const other = bps.find((b) => b.mode === "operate");
    if (other) expect(other.kit).toBeUndefined();
  });
});

describe("blueprints — seed library", () => {
  it("seeds the starter blueprints with a 'default'", () => {
    const bps = makeBlueprints();
    expect(bps.find((b) => b.id === "default")).toBeTruthy();
    // #3785 made `default` the greenfield superset; #3783 adds the five domain greenfields
    // (crm/erp/helpdesk/hr/project-management) that walk that same route.
    expect(bps.length).toBe(6);
    for (const id of ["crm", "erp", "helpdesk", "hr", "project-management"]) {
      expect(bps.find((b) => b.id === id), `built-in blueprint '${id}' present`).toBeTruthy();
    }
  });

  it("each section carries a prompt module and a gate from its def", () => {
    const ctx = makeBlueprints()[0].sections.find((s) => s.key === "discovery")!;
    expect(ctx.prompt.length).toBeGreaterThan(20);
    expect(ctx.gate).toBe(STAGE_DEFS.discovery.gate);
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
    expect(STAGE_DEFS.ui.deps).toContain("features");
  });

  it("the Skills stage is SKIPPABLE — an opt-in stage must never trap the plan (#3905)", () => {
    // Skills sits behind the `needsSkills` opt-in AND self-enables whenever the project resolves
    // any skill (`needsSkills: !!classifyCfg?.needsSkills || projectSkillCount > 0`). Without
    // `optional` it offered no Skip, and its gate signal `skillsAck` was hardcoded false — so once
    // the stage appeared the plan could never complete and TRIAGE became unreachable.
    expect(STAGE_DEFS.skills.optional, "skills must declare optional so the footer offers Skip").toBe(true);
    // …and the flag survives the section build (`mkStage` inherits `optional ?? def.optional`).
    expect(mkStage("skills").optional).toBe(true);
    // The gate still MEANS something: it requires `skillsAck`, which is satisfied by having skills,
    // not by a stub. (A `needsSkills` project with zero skills assigned still blocks.)
    expect(STAGE_DEFS.skills.gateRule?.require?.[0]?.signal).toBe("skillsAck");
  });

  it("the ui stage teaches the data-shape layout picker (#2475, moved from test_ui #4249)", () => {
    // #4249: `test_ui` sat in NO blueprint while owning half the pipeline, so the kit query moved to
    // `ui` — where the screens are actually specced and the designer is actually commissioned.
    const def = STAGE_DEFS.ui;
    expect(def).toBeTruthy();
    // The seed teaches the flow: derive the data's shape, then query the kit's ideals via the two
    // read verbs — and treat an uncovered shape as a gap, never a forced fit.
    for (const text of [def.prompt ?? "", def.directive ?? ""]) {
      expect(text).toContain("bsc ui shapes");
      expect(text).toContain("bsc ui list --shape");
    }
    // The whole seven-shape vocabulary is named for the planner to derive against (#2475/#3517).
    for (const shape of ["list", "linked-list", "tree", "graph", "table", "key-value", "series"]) {
      expect(def.prompt ?? "", `prompt names the ${shape} shape`).toContain(shape);
    }
  });

  it("the layout stages close the schema → shape → component loop (#2478)", () => {
    // #2475 gave the planner "which component renders shape X" (`bsc ui shapes`). #2478 supplies the
    // OTHER half — "what shape IS this entity's data" — inferred from the canonical Data Model by
    // `bsc data shapes` (crates/data `shape.rs`). The stage that picks a layout must teach it, or the
    // session is back to judging the taxonomy by hand. ONE stage since #4249 — `test_ui` carried a
    // second copy of the whole loop while belonging to no blueprint.
    for (const key of ["ui"]) {
      const def = STAGE_DEFS[key];
      expect(def, `${key} stage def exists`).toBeTruthy();
      for (const text of [def.prompt ?? "", def.directive ?? ""]) {
        expect(text, `${key} teaches the schema→shape verb`).toContain("bsc data shapes");
      }
      // The inference returns RANKED candidates with reasons, never one guess — and a tie goes to
      // the user (a lone self-reference is a tree only if an item has ONE parent).
      const both = `${def.prompt ?? ""}\n${def.directive ?? ""}`.toLowerCase();
      expect(both, `${key} says the candidates are ranked`).toContain("rank");
      expect(
        both.includes("ask the user") || both.includes("put the question to the user"),
        `${key} tells the session to ask when the top candidates tie`,
      ).toBe(true);
      // The vocabulary the two CLIs share — pinned so the prose can't teach a rejected token.
      for (const shape of ["list", "linked-list", "tree", "graph", "table", "key-value"]) {
        expect(both, `${key} names the ${shape} shape`).toContain(shape);
      }
    }
  });

  it("the ui stage teaches the theme pairing + the swappable-CSS emission (#2489, moved from test_ui #4249)", () => {
    // This was the sharpest consequence of `test_ui` being orphaned: it owned the ONLY path that
    // records a project's {kit, theme} pair and emits its palette, so no generated project ever got a
    // theme. Pairing is a step inside commissioning a UI, so it lives with the commission.
    const def = STAGE_DEFS.ui;
    // Both faces of the seed teach the whole loop: enumerate themes, choose WITH the user, record
    // the {kit, theme} pair in plan.db, and emit the two-layer palette for the generated app.
    for (const text of [def.prompt ?? "", def.directive ?? ""]) {
      expect(text).toContain("bsc ui theme list");
      expect(text).toContain("bsc plan ui set");
      expect(text).toContain("bsc ui emit-css");
      expect(text).toContain("tokens.css");
      expect(text).toContain("theme.css");
      // Re-theming is the one-file swap — the payoff the stage must state.
      expect(text).toMatch(/swapping (that one file|theme\.css)/);
    }
    // The token contract layer is read-only for the build agents.
    expect(def.prompt).toMatch(/read-only for build agents/);
    expect(def.directive).toMatch(/read-only for workers/);
  });

  it("carries the MCPs stage after Streams in the Default blueprint (#878/#1003/#1914/#3785)", () => {
    expect(STAGE_DEFS.mcps).toBeTruthy();
    // #3785: mcps is now a non-optional section on the unified Default blueprint (hidden-by-default
    // via appliesWhen signals, not the `optional` flag).
    expect(STAGE_DEFS.mcps.optional).not.toBe(true);
    for (const id of ["default"]) {
      const bp = makeBlueprints().find((b) => b.id === id)!;
      const keys = bp.sections.map((s) => s.key);
      expect(keys, `${id} has an mcps stage`).toContain("mcps");
      // #1914: structure+permissions collapsed into the `streams` stage; mcps comes after it.
      expect(keys.indexOf("mcps"), `${id}: mcps after streams`).toBeGreaterThan(keys.indexOf("streams"));
    }
  });

  it("market is a discovery-toggled optional stage — right after Discovery, hidden until needsMarket (#2430/#3806)", () => {
    for (const id of ["default"]) {
      const bp = makeBlueprints().find((b) => b.id === id)!;
      const secs = bp.sections;
      const keys = secs.map((s) => s.key);
      // #3806: the Configure stage folded into Discovery, so market now follows Discovery directly.
      expect(keys.indexOf("market"), `${id}: market right after discovery`).toBe(keys.indexOf("discovery") + 1);
      // No longer the `optional` flag — market is signal-gated like source/mcp/skills/automations:
      // hidden (N/A) by default, shown only once the planner sets needsMarket during Discovery.
      const market = secs.find((s) => s.key === "market")!;
      expect(market.optional).not.toBe(true);
      expect(stageStatus(market, secs, { ...sig(), needsMarket: false }).status).toBe("na");
      expect(stageStatus(market, secs, { ...sig(), needsMarket: true }).status).not.toBe("na");
    }
  });

  it("Default is the superset greenfield route; the domain greenfields walk it (#1003/#1914/#3785/#3783)", () => {
    const bp = (id: string) => makeBlueprints().find((b) => b.id === id)!;
    const keysOf = (id: string) => bp(id).sections.map((s) => s.key);
    // #3785: Default absorbed Complete's stages — it's the greenfield superset. The unified
    // vocabulary (#1914) collapsed repos+deploy → `deployment` and structure+permissions → `streams`.
    expect(keysOf("default")).toEqual(
      ["discovery", "market", "deployment", "source", "features", "ui", "streams", "mcps", "automations", "skills"],
    );
    // The legacy collapsed keys never survive the unified vocabulary.
    for (const k of ["repos", "structure", "permissions"]) {
      expect(keysOf("default"), `default omits ${k}`).not.toContain(k);
    }
    // #3783: the built-ins are Default plus the domain blueprints.
    const builtIns = makeBlueprints().map((b) => b.id);
    expect(builtIns).toEqual(
      expect.arrayContaining(["default", "crm", "erp", "helpdesk", "hr", "project-management"]),
    );
    // Default is still the superset by keys — every domain blueprint's stages are a subset of it.
    const defaultKeys = new Set(keysOf("default"));
    for (const id of ["crm", "erp", "helpdesk", "hr", "project-management"]) {
      expect(keysOf(id).every((k) => defaultKeys.has(k)), `${id} keys ⊆ default`).toBe(true);
    }
  });

  it("classification folded into Discovery — there is no standalone Configure stage (#3806)", () => {
    // #3806: the Configure stage was removed; the planner classifies (uiMode + which optional stages
    // the project needs) as the closing step of Discovery. No blueprint carries a `configure` section,
    // and the registry has no `configure` def.
    expect(STAGE_DEFS.configure).toBeUndefined();
    for (const bp of makeBlueprints()) {
      expect(bp.sections.map((s) => s.key), `${bp.id} has no configure stage`).not.toContain("configure");
    }
  });

});

// #1854 Phase (a): a stage can carry model-variant prompts (adapt the prompt to the driving model's
// capability tier) + archetype seed content. Both are additive — absent ⇒ today's single-prompt,
// no-seed behavior.
describe("dynamic blueprints — model-variant prompts (#1854a)", () => {
  const base: Pick<SectionDef, "prompt" | "promptVariants"> = {
    prompt: "Open-ended: design the feature set with the user.",
    promptVariants: {
      local: "Tight: list EXACTLY 5 features as `- name: one-line` and nothing else.",
    },
  };

  it("returns the base prompt when no tier is given (today's behavior)", () => {
    expect(resolveStagePrompt(base)).toBe(base.prompt);
  });

  it("returns the base prompt for a tier that has no variant (direct fallback, no cascade)", () => {
    // `standard` isn't defined and `frontier`'s prompt IS the base → both fall back to `prompt`.
    expect(resolveStagePrompt(base, "standard")).toBe(base.prompt);
    expect(resolveStagePrompt(base, "frontier")).toBe(base.prompt);
  });

  it("picks the tier's variant when one is defined (the weak-local-model payoff)", () => {
    expect(resolveStagePrompt(base, "local")).toBe(base.promptVariants!.local);
  });

  it("falls back to the base prompt when the variant is empty/whitespace", () => {
    const blankLocal = { prompt: "P", promptVariants: { local: "   " } } as Pick<SectionDef, "prompt" | "promptVariants">;
    expect(resolveStagePrompt(blankLocal, "local")).toBe("P");
  });

  it("a stage with no promptVariants resolves to its base prompt for every tier", () => {
    const plain = { prompt: "just the one prompt" } as Pick<SectionDef, "prompt" | "promptVariants">;
    for (const tier of ["frontier", "standard", "local"] as const) {
      expect(resolveStagePrompt(plain, tier)).toBe("just the one prompt");
    }
  });

  it("returns '' for a missing section", () => {
    expect(resolveStagePrompt(undefined)).toBe("");
    expect(resolveStagePrompt(undefined, "local")).toBe("");
  });

  it("every built-in stage still resolves its plain prompt unchanged (additive, no regressions)", () => {
    for (const [key, def] of Object.entries(STAGE_DEFS)) {
      expect(resolveStagePrompt(def), `stage '${key}' base`).toBe(def.prompt);
      // No built-in stage declares variants yet — so a tiered resolve is identical.
      expect(resolveStagePrompt(def, "local"), `stage '${key}' local`).toBe(def.prompt);
    }
  });
});

describe("dynamic blueprints — archetype seed content (#1854a)", () => {
  it("returns the seed when the stage carries non-empty content", () => {
    const seeded = { seed: { archetype: "twitter-clone", content: "- Post a tweet\n- Follow a user" } } as Pick<SectionDef, "seed">;
    expect(stageSeed(seeded)?.archetype).toBe("twitter-clone");
    expect(stageSeed(seeded)?.content).toContain("Post a tweet");
  });

  it("treats an empty/whitespace or absent seed as none", () => {
    expect(stageSeed({ seed: { content: "   " } } as Pick<SectionDef, "seed">)).toBeUndefined();
    expect(stageSeed({} as Pick<SectionDef, "seed">)).toBeUndefined();
    expect(stageSeed(undefined)).toBeUndefined();
  });

  it("no built-in stage carries a seed yet (additive default)", () => {
    for (const def of Object.values(STAGE_DEFS)) expect(stageSeed(def)).toBeUndefined();
  });
});

describe("blueprints — computeStatus (dependency locks)", () => {
  it("locks a section whose enabled dependency is disabled", () => {
    // streams depends on discovery, deployment, features; disable deployment -> streams locked (#1914).
    const secs = [mkStage("discovery"), mkStage("deployment", { enabled: false }), mkStage("features"), mkStage("streams")];
    const st = computeStatus(secs);
    expect(st.streams.locked).toBe(true);
    expect(st.streams.unmet).toContain("deployment");
  });

  it("a dependency omitted from the blueprint is treated as met", () => {
    // streams present but ui omitted entirely -> ui not counted as unmet.
    const secs = [mkStage("discovery"), mkStage("deployment"), mkStage("streams")];
    const st = computeStatus(secs);
    expect(st.streams.unmet).not.toContain("ui");
    expect(st.streams.locked).toBe(false);
  });

  it("all deps enabled -> not locked, satisfied", () => {
    const secs = [mkStage("discovery"), mkStage("deployment"), mkStage("features"), mkStage("streams")];
    const st = computeStatus(secs);
    expect(st.streams.locked).toBe(false);
    expect(st.streams.satisfied).toBe(true);
  });
});

describe("blueprints — stage def integrity", () => {
  it("every stage def's deps reference an existing stage key (no dangling deps)", () => {
    // Guards against a stage rename that leaves a stale dep pointing at the old key.
    // computeStatus silently drops an absent dep (a dep this blueprint omits is treated
    // as met), so a severed prerequisite lock would otherwise pass unnoticed — exactly
    // what the #1578 context→discovery rename did to 9 stage defs (#1601).
    const keys = new Set(Object.keys(STAGE_DEFS));
    const dangling: string[] = [];
    for (const [key, def] of Object.entries(STAGE_DEFS)) {
      for (const dep of def.deps ?? []) {
        if (!keys.has(dep)) dangling.push(`${key} -> ${dep}`);
      }
    }
    expect(dangling).toEqual([]);
  });
});

describe("blueprints — helpers", () => {
  it("reorder moves an item before/after a target by uid", () => {
    const a = [{ uid: "x" }, { uid: "y" }, { uid: "z" }];
    expect(reorder(a, "z", "x", true).map((o) => o.uid)).toEqual(["z", "x", "y"]);
    expect(reorder(a, "x", "z", false).map((o) => o.uid)).toEqual(["y", "z", "x"]);
  });

  it("cloneStages gives fresh uids", () => {
    const src = [mkStage("ui")];
    const copy = cloneStages(src);
    expect(copy[0].uid).not.toBe(src[0].uid);
    expect(copy[0].key).toBe("ui");
  });
});

describe("blueprints — section status (declarative, blueprint-driven gates)", () => {
  // #1914: streams depends on discovery+deployment+features; build a set where those are satisfiable.
  const baseSecs = () => [
    mkStage("discovery"), mkStage("deployment"), mkStage("ui"), mkStage("streams"),
    mkStage("skills"),
  ];
  const doneCtx = { discovery: { resolved: 1, total: 1, requiredDiscoveryReady: true }, repoCount: 1, requiresUi: false };

  it("evaluates a section's own declarative gate (not a hardcoded enum)", () => {
    const secs = baseSecs();
    const deployment = secs.find((s) => s.key === "deployment")!;
    // deployment gates on BOTH a linked repo AND shipping defined (#1914).
    expect(stageStatus(deployment, secs, sig({ repoCount: 0 })).status).toBe("in-progress");
    expect(stageStatus(deployment, secs, { ...sig({ repoCount: 2 }), deploymentDefined: true }).status).toBe("complete");
  });

  it("UI section is N/A when the project needs no UI (appliesWhen)", () => {
    const secs = baseSecs();
    const ui = secs.find((s) => s.key === "ui")!;
    expect(stageStatus(ui, secs, sig({ requiresUi: false })).status).toBe("na");
  });

  it("locks a section whose enabled dependency is incomplete", () => {
    const secs = baseSecs();
    const streams = secs.find((s) => s.key === "streams")!;
    // discovery not ready → streams locked (it depends on discovery + deployment).
    expect(stageStatus(streams, secs, sig({ requiresUi: false })).status).toBe("locked");
  });

  it("a gateless (informational) section completes only when confirmed, not vacuously (#664)", () => {
    // mcps is gateless (no gateRule); forced non-optional it plays the required-informational role the
    // archived `testing` stage used to (completes only on confirm, never vacuously).
    const secs = [mkStage("discovery"), mkStage("mcps", { optional: false })];
    const info = secs.find((s) => s.key === "mcps")!;
    // `mcps` only APPLIES when the project is classified as needing MCP servers (#3784) — without
    // that signal it reads "na", which is a different assertion than the gateless-completion one
    // this test makes. Turn it on so the section is applicable, then measure its completion.
    const applies = { ...sig(), needsMcp: true };
    // not vacuously complete on a fresh/cleared plan
    expect(stageStatus(info, secs, applies).status).toBe("in-progress");
    // complete once the section is confirmed
    expect(stageStatus(info, secs, { ...applies, [confirmedSignal("mcps")]: true }).status).toBe("complete");
  });

  it("an optional stage is shown + never locks dependents, but IS a deliberate stop the user must decide (#676/#921)", () => {
    const secs = [mkStage("discovery"), mkStage("ui", { optional: true }), mkStage("streams")];
    const signals = sig({ discovery: { resolved: 1, total: 1, requiredDiscoveryReady: true }, requiresUi: true,
      issueCount: 1 });
    const ui = secs.find((s) => s.key === "ui")!;
    // shown (not N/A) even though its screens gate is unmet
    expect(stageStatus(ui, secs, signals).status).not.toBe("na");
    // an optional dep never locks the dependent (#676)
    expect(stageStatus(secs.find((s) => s.key === "streams")!, secs, signals).status).not.toBe("locked");
    // #921: the flow now STOPS on the optional stage — once context is done it IS the current stage,
    // so the user decides whether to do or skip it (was: optional excluded from the frontier).
    expect(currentStage(secs, signals)?.key).toBe("ui");
    // …and an undecided optional stage blocks plan completion until the user decides (do or skip).
    const twoSec = [mkStage("discovery"), mkStage("ui", { optional: true })];
    const ctxDone = sig({ discovery: { resolved: 1, total: 1, requiredDiscoveryReady: true }, requiresUi: true });
    expect(planStagesComplete(twoSec, ctxDone)).toBe(false);
    // a USER-skip resolves the optional stage → it counts as done, the frontier advances, plan completes.
    const skipped = { ...ctxDone, [skippedSignal("ui")]: true };
    expect(stageDone(ui, skipped).done).toBe(true);
    expect(currentStage(twoSec, skipped)?.key).toBe("ui"); // last applicable once all resolved
    expect(planStagesComplete(twoSec, skipped)).toBe(true);
  });

  it("incompleteStages lists each unfinished section with its gate reason", () => {
    const secs = baseSecs();
    const inc = incompleteStages(secs, sig({ requiresUi: false }));
    const ctx = inc.find((i) => i.key === "discovery");
    expect(ctx?.reason).toBe(STAGE_DEFS.discovery.gate);
    // ui is N/A here, so it must not appear
    expect(inc.some((i) => i.key === "ui")).toBe(false);
  });

  it("planStagesComplete is true only when every enabled, applicable section is done", () => {
    const secs = setEnabled(baseSecs(), "ui", false); // drop ui to simplify
    expect(planStagesComplete(secs, sig(doneCtx))).toBe(false); // deployment/streams/skills unmet
    const allDone = {
      ...doneCtx,
      features: { count: 1, allConfirmed: true }, // streams gates on featuresDefined (#1912)
      fleet: { streams: 2, profilesComplete: true }, skillsAck: true,
    };
    // deploymentDefined + sharedDepsLocked are extra signals (added in Planning.tsx alongside
    // hasPlanGaps), not part of planStateToSignals — supply them the same way the app does. With no
    // multi-stream repos sharedDepsLocked is true (#1429).
    expect(planStagesComplete(secs, { ...sig(allDone), sharedDepsLocked: true, deploymentDefined: true })).toBe(true);
  });

  it("currentStage is the first in-progress section, skipping N/A", () => {
    const secs = baseSecs();
    // context complete, deployment incomplete, ui N/A → deployment is the frontier
    const s = sig({ discovery: { resolved: 1, total: 1, requiredDiscoveryReady: true }, repoCount: 0, requiresUi: false });
    expect(currentStage(secs, s)?.key).toBe("deployment");
  });

  it("blueprintToStageConfig maps enabled+order over known stages, dropping non-registry sections", () => {
    const known = new Set(PLAN_STAGES.map((s) => s.id));
    // a blueprint including "mcps" (a non-registry stage) — dropped from the stage config order.
    const bp = { id: "t", name: "T", desc: "", sections: [mkStage("discovery"), mkStage("deployment"), mkStage("streams"), mkStage("mcps")] } as Blueprint;
    const cfg = blueprintToStageConfig(bp);
    // order only contains registry stage ids, in blueprint order
    expect(cfg.order.every((id) => known.has(id))).toBe(true);
    expect(cfg.order).not.toContain("mcps" as never);
    // a section's enabled flag carries through
    const deployment = bp.sections.find((s) => s.key === "deployment")!;
    expect(cfg.enabled.deployment).toBe(deployment.enabled);
  });
});

describe("lint-as-gate (#897 Phase 4b)", () => {
  it("wires a hasPlanGaps requirement into the discovery + streams gates", () => {
    for (const key of ["discovery", "streams"] as const) {
      const reqs = STAGE_DEFS[key].gateRule?.require ?? [];
      const r = reqs.find((x) => x.signal === "hasPlanGaps");
      expect(r, `${key} has a hasPlanGaps requirement`).toBeTruthy();
      expect(r!.target).toBe(false); // must be FALSE (no gaps) to pass
      expect(r!.weight).toBe(0);     // must-pass, doesn't move the progress fill
    }
  });

  it("blocks the gate on an unresolved placeholder, passes when clean or absent (absent-safe)", () => {
    const gate = STAGE_DEFS.discovery.gateRule!;
    const base = { requiredDiscoveryReady: true, topicsResolved: 3, topicsTotal: 3 }; // other context reqs satisfied
    expect(evalGate(gate, { ...base, hasPlanGaps: true }).done).toBe(false);  // a TODO/placeholder blocks
    expect(evalGate(gate, { ...base, hasPlanGaps: false }).done).toBe(true);  // clean passes
    expect(evalGate(gate, base).done).toBe(true);                             // signal absent ⇒ passes
  });
});

describe("Deploy + the dependency gate move to Streams (#1127/#1429)", () => {
  it("has no standalone dependencies section anymore", () => {
    expect(STAGE_DEFS.dependencies).toBeUndefined();
    expect(makeBlueprints().find((b) => b.id === "default")!.sections.map((s) => s.key)).not.toContain("dependencies");
  });

  it("Deploy gates on shipping only — dependencies moved to the Streams stage (#1429)", () => {
    const gate = STAGE_DEFS.deployment.gateRule!;
    const signals = gate.require.map((r) => r.signal);
    expect(signals).toContain("deploymentDefined");
    expect(signals).not.toContain("dependenciesDefined"); // deps no longer gate Deploy
    // #1914: deployment is a UNION gate (a repo linked AND shipping defined); supply repoCount so
    // toggling deploymentDefined is what flips the gate.
    expect(evalGate(gate, { repoCount: 1, deploymentDefined: false }).done).toBe(false);
    expect(evalGate(gate, { repoCount: 1, deploymentDefined: true }).done).toBe(true);
  });

  it("the Streams gate requires shared deps locked (#1429/#1914)", () => {
    const gate = STAGE_DEFS.streams.gateRule!;
    expect(gate.require.map((r) => r.signal)).toContain("sharedDepsLocked");
    expect(evalGate(gate, { featuresDefined: true, fleetStreams: 1, profilesComplete: true, sharedDepsLocked: false }).done).toBe(false);
    expect(evalGate(gate, { featuresDefined: true, fleetStreams: 1, profilesComplete: true, sharedDepsLocked: true }).done).toBe(true);
  });

  it("the collapsed `deployment` def carries link+ship substeps + the union gate (#1914)", () => {
    // #1914: repos+deploy collapsed into ONE `deployment` def — link+ship substeps; the gate is the
    // UNION (a repo linked AND shipping). Deps live in the Streams stage now (#1429).
    const dep = mkStage("deployment");
    expect(dep.name).toBe("Deployment");
    expect(dep.substeps?.map((s) => s.key)).toEqual(["link", "ship"]);
    const sig = dep.gateRule!.require.map((r) => r.signal);
    expect(sig).toEqual(expect.arrayContaining(["repoCount", "deploymentDefined"]));
    expect(sig).not.toContain("dependenciesDefined");
    expect(evalGate(dep.gateRule!, { repoCount: 1, deploymentDefined: false }).done).toBe(false);
    expect(evalGate(dep.gateRule!, { repoCount: 1, deploymentDefined: true }).done).toBe(true);
  });

  it("the greenfield blueprints carry the collapsed `deployment` stage (#1914)", () => {
    const depRef = (id: string) => makeBlueprints().find((b) => b.id === id)!.sections.find((s) => s.key === "deployment");
    for (const id of ["default"]) {
      expect(depRef(id)?.substeps?.some((s) => s.key === "ship"), `${id} ships via deployment`).toBe(true);
      const keys = makeBlueprints().find((b) => b.id === id)!.sections.map((s) => s.key);
      expect(keys).not.toContain("repos");
      expect(keys).not.toContain("deploy");
    }
  });

  it("the collapsed `streams` def carries plan+fleet substeps + the union gate (#1914)", () => {
    // #1914: structure+permissions collapsed into ONE `streams` def — plan+fleet substeps; the gate
    // is the UNION (features defined AND the fleet streams scoped + profiled + shared deps locked).
    const streams = mkStage("streams");
    expect(streams.name).toBe("Streams");
    expect(streams.substeps?.map((s) => s.key)).toEqual(["plan", "fleet"]);
    const subKeys = streams.substeps?.map((s) => s.key) ?? [];
    expect(subKeys[subKeys.length - 1]).toBe("fleet"); // the fleet marker is the focused-pane signal
    const sig = streams.gateRule!.require.map((r) => r.signal);
    expect(sig).toEqual(expect.arrayContaining(["featuresDefined", "fleetStreams", "profilesComplete", "sharedDepsLocked"]));
  });

  it("greenfield blueprints carry the collapsed `streams` stage (#1914)", () => {
    const streamsRef = (id: string) => makeBlueprints().find((b) => b.id === id)!.sections.find((s) => s.key === "streams");
    for (const id of ["default"]) {
      expect(streamsRef(id)?.substeps?.some((s) => s.key === "fleet"), `${id} fleets via streams`).toBe(true);
      const keys = makeBlueprints().find((b) => b.id === id)!.sections.map((s) => s.key);
      expect(keys).not.toContain("structure");
      expect(keys).not.toContain("permissions");
    }
  });
});

describe("dedupeSections", () => {
  it("keeps the first section per key and drops later duplicates", () => {
    const raw = [mkStage("discovery"), mkStage("deployment"), mkStage("deployment"), mkStage("streams")];
    const out = dedupeSections(raw);
    expect(out.map((s) => s.key)).toEqual(["discovery", "deployment", "streams"]);
  });

  it("a built-in blueprint's planner-overview stage keys ARE the canonical directive ids", () => {
    const def = makeBlueprints().find((b) => b.id === "default")!;
    const overview = def.sections.filter((s) => s.enabled).map((s) => s.key);
    expect(overview).toEqual(
      ["discovery", "market", "deployment", "source", "features", "ui", "streams", "mcps", "automations", "skills"],
    );
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

  it("attaches web-seo to the greenfield web blueprint", () => {
    const by = (id: string) => makeBlueprints().find((b) => b.id === id)!;
    expect(by("default").skills).toContain("web-seo");
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
