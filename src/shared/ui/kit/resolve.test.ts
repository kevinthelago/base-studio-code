import { describe, it, expect } from "vitest";
import { resolveTheme, themeHoles, referencedTokens, CONTRACT_TOKENS } from "./resolve";

describe("resolveTheme / themeHoles (#2637)", () => {
  it("referencedTokens extracts var(--x) names incl. fallbacks + color-mix operands", () => {
    expect(referencedTokens("var(--accent)")).toEqual(["--accent"]);
    expect(referencedTokens("var(--btn-bg, #000)")).toEqual(["--btn-bg"]);
    expect(referencedTokens("color-mix(in oklch, var(--bg-panel), var(--accent) 7%)")).toEqual(["--bg-panel", "--accent"]);
    expect(referencedTokens("#123456")).toEqual([]);
  });

  it("themeHoles flags var() refs OUTSIDE the contract, ignores contract tokens + raw values", () => {
    expect(themeHoles({ "--card-bg": "var(--accent)" })).toEqual([]); // --accent is a contract token
    expect(themeHoles({ "--card-bg": "var(--nope-xyz)" })).toEqual(["--nope-xyz"]);
    expect(themeHoles({ "--x": "color-mix(in oklch, var(--bg-panel), var(--zzz) 7%)" })).toEqual(["--zzz"]);
    expect(themeHoles({ "--card-bg": "#123456", "--card-radius": "8px" })).toEqual([]); // no var() refs
    expect(themeHoles({ "--a": "var(--q2)", "--b": "var(--q1) var(--q2)" })).toEqual(["--q1", "--q2"]); // deduped + sorted
  });

  it("the contract token set spans base + component + domain", () => {
    expect(CONTRACT_TOKENS.has("--accent")).toBe(true); // base
    expect(CONTRACT_TOKENS.has("--card-bg")).toBe(true); // component
    expect(CONTRACT_TOKENS.has("--graph-health-error")).toBe(true); // domain (#2607)
    expect(CONTRACT_TOKENS.has("--nope")).toBe(false);
  });

  it("resolveTheme: default → no overrides/holes; a real theme → provenance 'theme' for its vars", () => {
    const def = resolveTheme("default");
    expect(def.holes).toEqual([]);
    expect(Object.keys(def.provenance)).toEqual([]); // default carries empty vars

    const soft = resolveTheme("soft");
    expect(Object.keys(soft.provenance).length).toBeGreaterThan(0);
    expect(Object.values(soft.provenance).every((v) => v === "theme")).toBe(true);
    expect(soft.holes).toEqual([]); // built-in themes are clean
    // the applied vars are exactly the theme's override set (byte-identical to themeVars → zero visual)
    expect(Object.keys(soft.vars as Record<string, unknown>).length).toBe(Object.keys(soft.provenance).length);
  });
});
