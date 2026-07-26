import { describe, it, expect } from "vitest";
import {
  coerceClassifyConfig, appTypeOf, lifecycleOf, appTypeHasUi, classifySignals,
  APP_TYPES, LIFECYCLES,
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
    expect(sig.hasUserInterface).toBe(true);
  });

  it("emits a boolean for every token, so an absent signal is never ambiguous", () => {
    const sig = classifySignals({ appType: "cli" });
    for (const t of APP_TYPES) expect(typeof sig[`appType:${t}`]).toBe("boolean");
    for (const l of LIFECYCLES) expect(typeof sig[`lifecycle:${l}`]).toBe("boolean");
  });
});
