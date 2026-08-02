import { describe, it, expect } from "vitest";
import {
  coerceClassifyConfig, appTypeOf, lifecycleOf, appTypeHasUi, classifySignals,
  uiSystemOf, rendersFromStudio, algorithmSystemOf, computesFromStudio, hostRunsProjectArtifacts,
  APP_TYPES, LIFECYCLES, SYSTEM_SOURCES,
} from "./classifyConfig";

describe("coerceClassifyConfig", () => {
  it("drops a mistyped or unknown field rather than failing the whole blob", () => {
    const cfg = coerceClassifyConfig({
      uiMode: "custom", appType: "not-a-type", lifecycle: 7, needsSource: "yes", needsMcp: true,
    });
    expect(cfg).toEqual({ uiMode: "custom", needsMcp: true });
  });

  it("reads the two taxonomy axes when they carry valid tokens", () => {
    expect(coerceClassifyConfig({ appType: "mcp-server", lifecycle: "transform" }))
      .toEqual({ appType: "mcp-server", lifecycle: "transform" });
  });

  it("accepts every token in each published taxonomy", () => {
    for (const t of APP_TYPES) expect(coerceClassifyConfig({ appType: t })).toEqual({ appType: t });
    for (const l of LIFECYCLES) expect(coerceClassifyConfig({ lifecycle: l })).toEqual({ lifecycle: l });
    for (const s of SYSTEM_SOURCES) expect(coerceClassifyConfig({ uiSystem: s })).toEqual({ uiSystem: s });
  });

  it("keeps uiSystem and uiMode as independent axes (#4115)", () => {
    // The trap the axis exists to close: `external` is NOT "the project owns rendering" — it still
    // means our pipeline renders a shell from files the user supplies. All four combinations are real.
    expect(coerceClassifyConfig({ uiSystem: "own", uiMode: "external" }))
      .toEqual({ uiSystem: "own", uiMode: "external" });
    expect(coerceClassifyConfig({ uiSystem: "own", uiMode: "custom" }))
      .toEqual({ uiSystem: "own", uiMode: "custom" });
    // An unknown token is dropped, not coerced to a neighbour — a typo must not silently opt a
    // project INTO a UI system it doesn't use.
    expect(coerceClassifyConfig({ uiSystem: "owned" })).toEqual({});
    expect(coerceClassifyConfig({ uiSystem: "external" })).toEqual({});
  });

  it("reads the two SYSTEM axes independently (#4115)", () => {
    // They differ often — owning the UI while still drawing algorithms from the graph is a normal
    // project, and it is exactly the case a single combined answer would get wrong.
    expect(coerceClassifyConfig({ uiSystem: "own", algorithmSystem: "studio" }))
      .toEqual({ uiSystem: "own", algorithmSystem: "studio" });
    expect(coerceClassifyConfig({ uiSystem: "studio", algorithmSystem: "own" }))
      .toEqual({ uiSystem: "studio", algorithmSystem: "own" });
    for (const s of SYSTEM_SOURCES) {
      expect(coerceClassifyConfig({ algorithmSystem: s })).toEqual({ algorithmSystem: s });
    }
    // Same discipline as its twin: a bad token is dropped, never coerced.
    expect(coerceClassifyConfig({ algorithmSystem: "graph" })).toEqual({});
  });

  it("reads a non-object as null and an empty object as an empty config", () => {
    expect(coerceClassifyConfig(null)).toBeNull();
    expect(coerceClassifyConfig("custom")).toBeNull();
    expect(coerceClassifyConfig({})).toEqual({});
  });
});

describe("the unclassified defaults", () => {
  // The load-bearing invariant (#3784): classification must never hide a stage that showed before
  // the planner classified, so every default reads as the permissive value.
  it("reads an unclassified project as a greenfield application WITH a UI", () => {
    for (const cfg of [undefined, null, {}]) {
      expect(appTypeOf(cfg)).toBe("application");
      expect(lifecycleOf(cfg)).toBe("greenfield");
      expect(appTypeHasUi(cfg)).toBe(true);
    }
  });

  it("reads an unclassified project as studio-rendered — the axis is non-regressing (#4115)", () => {
    // Every project that exists today renders from our system, so unset MUST read as "studio":
    // that is what makes the axis additive with no migration and no backfill.
    for (const cfg of [undefined, null, {}]) {
      expect(uiSystemOf(cfg)).toBe("studio");
      expect(rendersFromStudio(cfg)).toBe(true);
    }
    // …and an explicit `own` is the only thing that turns our pipeline off.
    expect(rendersFromStudio({ uiSystem: "own" })).toBe(false);
    expect(uiSystemOf({ uiSystem: "own" })).toBe("own");
    // uiMode alone never opts a project out — the whole point of the separate axis.
    expect(rendersFromStudio({ uiMode: "external" })).toBe(true);
  });

  it("reads an unclassified project as studio for BOTH systems", () => {
    for (const cfg of [undefined, null, {}]) {
      expect(algorithmSystemOf(cfg)).toBe("studio");
      expect(computesFromStudio(cfg)).toBe(true);
      expect(hostRunsProjectArtifacts(cfg)).toBe(true);
    }
    expect(computesFromStudio({ algorithmSystem: "own" })).toBe(false);
  });
});

describe("hostRunsProjectArtifacts — the isolate-before-render question (#4115)", () => {
  // `studio` means our HOST takes the project's LLM-authored code in and runs it: UI rendered in a
  // frame (opaque-origin in ComponentPreviewFrame; #3862 is the frame that still isn't), algorithms
  // compiled with `new Function` and executed in the vizCode worker (#3233). So this must be an OR —
  // isolation is owed if ANY one surface hosts project code.
  it("is true when EITHER system is studio, not only when the UI is", () => {
    expect(hostRunsProjectArtifacts({ uiSystem: "own", algorithmSystem: "studio" })).toBe(true);
    expect(hostRunsProjectArtifacts({ uiSystem: "studio", algorithmSystem: "own" })).toBe(true);
    expect(hostRunsProjectArtifacts({ uiSystem: "studio", algorithmSystem: "studio" })).toBe(true);
  });

  it("is false only when the project owns BOTH halves", () => {
    expect(hostRunsProjectArtifacts({ uiSystem: "own", algorithmSystem: "own" })).toBe(false);
  });

  it("would answer wrongly if it read only the UI axis — the regression this guards", () => {
    // The project that owns its UI but draws algorithms from the graph: reading `uiSystem` alone says
    // "we host nothing", while its vizCode still executes here. That is the drop this predicate exists
    // to prevent, and it's the more dangerous half — it runs code rather than rendering it.
    const ownUiStudioAlgorithms = { uiSystem: "own", algorithmSystem: "studio" } as const;
    expect(rendersFromStudio(ownUiStudioAlgorithms)).toBe(false);
    expect(hostRunsProjectArtifacts(ownUiStudioAlgorithms)).toBe(true);
  });
});

describe("appTypeHasUi", () => {
  it("is true exactly for the app types that have screens", () => {
    const withUi = APP_TYPES.filter((t) => appTypeHasUi({ appType: t }));
    expect(withUi.sort()).toEqual(["application", "desktop", "mobile", "static"]);
  });

  it("is false for the headless types, so their UI stage drops", () => {
    for (const t of ["api", "serverless", "cli", "library", "mcp-server"] as const) {
      expect(appTypeHasUi({ appType: t })).toBe(false);
    }
  });
});

describe("classifySignals", () => {
  it("publishes exactly one true signal per axis", () => {
    const sig = classifySignals({ appType: "api", lifecycle: "harden" });
    expect(sig["appType:api"]).toBe(true);
    expect(sig["appType:application"]).toBe(false);
    expect(sig["lifecycle:harden"]).toBe(true);
    expect(sig["lifecycle:greenfield"]).toBe(false);
    expect(APP_TYPES.filter((t) => sig[`appType:${t}`])).toEqual(["api"]);
    expect(LIFECYCLES.filter((l) => sig[`lifecycle:${l}`])).toEqual(["harden"]);
  });

  it("carries hasUserInterface so a stage's appliesWhen can key on it", () => {
    expect(classifySignals({ appType: "mcp-server" }).hasUserInterface).toBe(false);
    expect(classifySignals({ appType: "mobile" }).hasUserInterface).toBe(true);
  });

  it("emits the default axes for an unclassified project", () => {
    const sig = classifySignals(undefined);
    expect(sig["appType:application"]).toBe(true);
    expect(sig["lifecycle:greenfield"]).toBe(true);
    expect(sig["uiSystem:studio"]).toBe(true);
    expect(sig["algorithmSystem:studio"]).toBe(true);
    expect(sig.hasUserInterface).toBe(true);
    expect(sig.rendersFromStudio).toBe(true);
    expect(sig.computesFromStudio).toBe(true);
  });

  it("carries rendersFromStudio so a studio-only stage can drop for an `own` project (#4115)", () => {
    expect(classifySignals({ uiSystem: "own" }).rendersFromStudio).toBe(false);
    expect(classifySignals({ uiSystem: "own" })["uiSystem:own"]).toBe(true);
    expect(classifySignals({ uiSystem: "own" })["uiSystem:studio"]).toBe(false);
    // Independent of the screens question — an `own` project can still very much have a UI.
    expect(classifySignals({ uiSystem: "own", appType: "application" }).hasUserInterface).toBe(true);
  });

  it("carries the algorithm axis and the combined host signal too (#4115)", () => {
    const sig = classifySignals({ uiSystem: "own", algorithmSystem: "studio" });
    expect(sig.computesFromStudio).toBe(true);
    expect(sig["algorithmSystem:studio"]).toBe(true);
    expect(sig["algorithmSystem:own"]).toBe(false);
    // The two axes are independent signals, and the combined one is an OR over both.
    expect(sig.rendersFromStudio).toBe(false);
    expect(sig.hostRunsProjectArtifacts).toBe(true);
    expect(classifySignals({ uiSystem: "own", algorithmSystem: "own" }).hostRunsProjectArtifacts).toBe(false);
  });

  it("emits a boolean for every token, so an absent signal is never ambiguous", () => {
    const sig = classifySignals({ appType: "cli" });
    for (const t of APP_TYPES) expect(typeof sig[`appType:${t}`]).toBe("boolean");
    for (const l of LIFECYCLES) expect(typeof sig[`lifecycle:${l}`]).toBe("boolean");
    for (const s of SYSTEM_SOURCES) expect(typeof sig[`uiSystem:${s}`]).toBe("boolean");
    for (const s of SYSTEM_SOURCES) expect(typeof sig[`algorithmSystem:${s}`]).toBe("boolean");
  });
});
