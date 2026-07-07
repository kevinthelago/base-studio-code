import { describe, it, expect, afterEach } from "vitest";
import {
  themeById, themeVars, applyThemeToRoot, KIT_THEMES, KIT_TOKENS, DEFAULT_THEME,
  setActiveKitThemes, activeKitThemes, kitTokens,
} from "./theme";

// The active set is module state (#2488) — reset to the packaged registry after every test.
afterEach(() => setActiveKitThemes([]));

describe("kit theme registry", () => {
  it("loads several themes including the default", () => {
    expect(KIT_THEMES.length).toBeGreaterThan(1);
    expect(KIT_THEMES.find((t) => t.id === DEFAULT_THEME)).toBeTruthy();
  });

  it("themeById falls back to default for an unknown id", () => {
    expect(themeById("nope").id).toBe(DEFAULT_THEME);
    expect(themeById("soft").id).toBe("soft");
  });

  it("themeVars returns the override map; default is empty", () => {
    expect((themeVars("soft") as Record<string, string>)["--card-radius"]).toBe("14px");
    expect(themeVars("default")).toEqual({});
  });

  it("KIT_TOKENS covers every token any theme sets", () => {
    for (const t of KIT_THEMES) {
      for (const token of Object.keys(t.vars)) expect(KIT_TOKENS).toContain(token);
    }
  });
});

describe("applyThemeToRoot", () => {
  it("sets a theme's vars, then clears them when switching back to default", () => {
    const el = document.createElement("div");
    applyThemeToRoot("soft", el);
    expect(el.style.getPropertyValue("--card-radius")).toBe("14px");
    expect(el.style.getPropertyValue("--card-bg")).toBe("var(--bg-elev)");
    // Switching to default (no overrides) must REMOVE the prior theme's props, not leave them stale.
    applyThemeToRoot("default", el);
    expect(el.style.getPropertyValue("--card-radius")).toBe("");
    expect(el.style.getPropertyValue("--card-bg")).toBe("");
  });
});

describe("the hydrated active set (#2488)", () => {
  const neon = { id: "neon", label: "Neon", description: "glow", vars: { "--card-bg": "black" } };

  it("defaults to the packaged registry and resets on an empty sync", () => {
    expect(activeKitThemes()).toEqual(KIT_THEMES);
    setActiveKitThemes([neon]);
    expect(activeKitThemes()).toEqual([neon]);
    setActiveKitThemes([]); // a degenerate hydrate can never blank every theme
    expect(activeKitThemes()).toEqual(KIT_THEMES);
  });

  it("themeById/themeVars resolve store-authored themes once synced, with the packaged default fallback", () => {
    setActiveKitThemes([...KIT_THEMES, neon]);
    expect(themeById("neon").label).toBe("Neon");
    expect((themeVars("neon") as Record<string, string>)["--card-bg"]).toBe("black");
    // An active set missing `default` still falls back to the PACKAGED default (never undefined).
    setActiveKitThemes([neon]);
    expect(themeById("nope").id).toBe(DEFAULT_THEME);
  });

  it("a hydrated EDIT of a built-in wins over the packaged copy", () => {
    const softEdit = { id: "soft", label: "Soft", description: "d", vars: { "--card-radius": "9px" } };
    setActiveKitThemes([...KIT_THEMES.filter((t) => t.id !== "soft"), softEdit]);
    expect((themeVars("soft") as Record<string, string>)["--card-radius"]).toBe("9px");
  });

  it("kitTokens unions active + packaged, so applyThemeToRoot clears store-theme tokens on switch", () => {
    const shadowed = { id: "shadowy", label: "S", description: "", vars: { "--chip-fg": "red" } };
    setActiveKitThemes([...KIT_THEMES, shadowed]);
    expect(kitTokens()).toEqual(expect.arrayContaining([...KIT_TOKENS, "--chip-fg"]));
    const el = document.createElement("div");
    applyThemeToRoot("shadowy", el);
    expect(el.style.getPropertyValue("--chip-fg")).toBe("red");
    // Switching to a theme that doesn't set the store-authored token CLEARS it.
    applyThemeToRoot("default", el);
    expect(el.style.getPropertyValue("--chip-fg")).toBe("");
  });
});
