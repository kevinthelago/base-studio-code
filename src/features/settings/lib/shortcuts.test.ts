import { describe, it, expect } from "vitest";
import { SCREEN_HOTKEYS, SCREEN_KEY_MAP, SHORTCUT_GROUPS } from "./shortcuts";

describe("shortcuts registry", () => {
  it("derives SCREEN_KEY_MAP from SCREEN_HOTKEYS (the single source)", () => {
    expect(Object.keys(SCREEN_KEY_MAP)).toHaveLength(SCREEN_HOTKEYS.length);
    for (const h of SCREEN_HOTKEYS) {
      expect(SCREEN_KEY_MAP[h.key]).toBe(h.screen);
    }
    // Spot-check the canonical F-key bindings. F1 was Console until #2403 retired that page; #4167 gave
    // it to Glance, which had no key at all despite being the screen the app lands on.
    expect(SCREEN_KEY_MAP.F1).toBe("glance");
    expect(SCREEN_KEY_MAP.F2).toBe("projects");
    expect(SCREEN_KEY_MAP.F6).toBe("github");
    expect(SCREEN_KEY_MAP.F7).toBe("security");
    expect(SCREEN_KEY_MAP.F8).toBe("settings");
  });

  it("documents every screen hotkey in the Navigation group, so the page can't drift", () => {
    const nav = SHORTCUT_GROUPS.find((g) => g.title === "Navigation")!;
    for (const h of SCREEN_HOTKEYS) {
      const entry = nav.items.find((s) => s.keys.length === 1 && s.keys[0] === h.key);
      expect(entry, `missing catalog entry for ${h.key}`).toBeTruthy();
      expect(entry!.desc).toContain(h.label);
    }
  });

  it("every group has items and every item has key caps + a description", () => {
    expect(SHORTCUT_GROUPS.length).toBeGreaterThan(0);
    for (const g of SHORTCUT_GROUPS) {
      expect(g.items.length).toBeGreaterThan(0);
      for (const s of g.items) {
        expect(s.keys.length).toBeGreaterThan(0);
        expect(s.keys.every((k) => k.length > 0)).toBe(true);
        expect(s.desc.length).toBeGreaterThan(0);
        expect(s.scope.length).toBeGreaterThan(0);
      }
    }
  });
});
