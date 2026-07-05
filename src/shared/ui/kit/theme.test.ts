import { describe, it, expect } from "vitest";
import { themeById, themeVars, applyThemeToRoot, KIT_THEMES, KIT_TOKENS, DEFAULT_THEME } from "./theme";

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
