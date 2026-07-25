import { describe, it, expect } from "vitest";
import { resolveTheme, themeHoles, referencedTokens, CONTRACT_TOKENS, resolveThemeTokens } from "./resolve";

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
    expect(CONTRACT_TOKENS.has("--tab-active-bg")).toBe(true); // tab variant (#3739)
    expect(CONTRACT_TOKENS.has("--modal-bg")).toBe(true); // modal (#3739)
    expect(CONTRACT_TOKENS.has("--switch-on-bg")).toBe(true); // switch variant (#3745)
    expect(CONTRACT_TOKENS.has("--icon-btn-danger-hover-fg")).toBe(true); // icon-btn variant (#3745)
    expect(CONTRACT_TOKENS.has("--graph-health-error")).toBe(true); // domain (#2607)
    expect(CONTRACT_TOKENS.has("--nope")).toBe(false);
  });

  it("resolveTheme: default → no overrides/holes; a real theme → provenance 'theme' for its vars", () => {
    const def = resolveTheme("default");
    expect(def.holes).toEqual([]);
    expect(Object.keys(def.provenance)).toEqual([]); // default carries empty vars

    const nord = resolveTheme("nord");
    expect(Object.keys(nord.provenance).length).toBeGreaterThan(0);
    expect(Object.values(nord.provenance).every((v) => v === "theme")).toBe(true);
    expect(nord.holes).toEqual([]); // built-in themes are clean
    // the applied vars are exactly the theme's override set (byte-identical to themeVars → zero visual)
    expect(Object.keys(nord.vars as Record<string, unknown>).length).toBe(Object.keys(nord.provenance).length);
  });
});

describe("resolveThemeTokens (#3711) — the JS projection", () => {
  it("flattens a base-look theme: a component token dereferences to its contract default", () => {
    const t = resolveThemeTokens("default");
    expect(t["--bg-panel"]).toBe("oklch(0.17 0.005 250)");
    // --card-bg is `var(--bg-panel)` in the contract → dereferenced to the same concrete value.
    expect(t["--card-bg"]).toBe("oklch(0.17 0.005 250)");
    expect(t["--card-bg"]).toBe(t["--bg-panel"]);
  });

  it("composes a theme's override THROUGH the var() chain", () => {
    // Nord overrides --bg-panel; --card-bg = var(--bg-panel), so it must resolve to nord's value.
    const t = resolveThemeTokens("nord");
    expect(t["--bg-panel"]).toBe("#323947");
    expect(t["--card-bg"]).toBe("#323947");
  });

  it("dereferences a var() nested inside color-mix", () => {
    expect(resolveThemeTokens("default")["--btn-danger-border"]).toBe(
      "color-mix(in oklch, oklch(0.68 0.18 25), transparent 70%)",
    );
    expect(resolveThemeTokens("nord")["--btn-danger-border"]).toBe(
      "color-mix(in oklch, #bf616a, transparent 70%)",
    );
  });

  it("passes literal values through untouched (colors, dimensions, durations)", () => {
    const t = resolveThemeTokens("default");
    expect(t["--btn-primary-border"]).toBe("transparent");
    expect(t["--r-md"]).toBe("6px");
    expect(t["--dur-fast"]).toBe("120ms");
  });

  it("resolves --btn-primary-fg through the new --on-accent base token (#3727)", () => {
    const t = resolveThemeTokens("default");
    expect(t["--on-accent"]).toBe("#1a120a");
    // --btn-primary-fg is now `var(--on-accent)` → dereferences to the on-accent ink (zero-visual).
    expect(t["--btn-primary-fg"]).toBe("#1a120a");
  });

  it("leaves an unknown (non-contract) token reference in place — --btn-font-family = var(--mono), a global outside the descriptor", () => {
    expect(resolveThemeTokens("default")["--btn-font-family"]).toBe("var(--mono)");
  });

  it("resolves the tab + modal tokens through their var() chains (#3739)", () => {
    const t = resolveThemeTokens("default");
    // literal passthrough
    expect(t["--tab-bg"]).toBe("transparent");
    // component tokens dereference to the SAME concrete value as their base token
    expect(t["--tab-fg"]).toBe(t["--fg-muted"]);
    expect(t["--tab-strip-bg"]).toBe(t["--bg-panel"]);
    expect(t["--tab-active-bg"]).toBe(t["--bg-canvas"]);
    expect(t["--tab-active-fg"]).toBe(t["--fg"]);
    expect(t["--modal-bg"]).toBe(t["--bg-elev"]);
    expect(t["--modal-border"]).toBe(t["--border"]);
    expect(t["--modal-radius"]).toBe(t["--r-lg"]);
    // a theme override composes THROUGH the chain (nord retints --bg-canvas)
    const n = resolveThemeTokens("nord");
    expect(n["--tab-active-bg"]).toBe(n["--bg-canvas"]);
  });

  it("resolves the switch + icon-btn control tokens through their var() chains (#3745)", () => {
    const t = resolveThemeTokens("default");
    // literal passthrough
    expect(t["--icon-btn-bg"]).toBe("transparent");
    // component tokens dereference to the SAME concrete value as their base token
    expect(t["--switch-bg"]).toBe(t["--bg-elev2"]);
    expect(t["--switch-thumb"]).toBe(t["--fg-muted"]);
    expect(t["--switch-on-border"]).toBe(t["--accent-dim"]);
    expect(t["--switch-on-thumb"]).toBe(t["--on-accent"]);
    expect(t["--icon-btn-fg"]).toBe(t["--fg-dim"]);
    expect(t["--icon-btn-hover-bg"]).toBe(t["--bg-elev2"]);
    expect(t["--icon-btn-danger-hover-fg"]).toBe(t["--danger"]);
    // the on-state track is a color-mix whose var(--accent) operand is dereferenced (like btn-danger-border)
    expect(t["--switch-on-bg"]).toBe(`color-mix(in oklch, ${t["--accent"]}, transparent 30%)`);
    // a theme override composes THROUGH the color-mix (nord retints --accent)
    const n = resolveThemeTokens("nord");
    expect(n["--switch-on-bg"]).toBe(`color-mix(in oklch, ${n["--accent"]}, transparent 30%)`);
  });
});
