import { describe, it, expect } from "vitest";
import { SCREENS, screenLabel, type Screen } from "./registry";

describe("screen registry (#nav-pass)", () => {
  it("gives every screen a non-empty label, a unique key, and an icon", () => {
    const keys = SCREENS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);                  // no duplicate keys
    expect(SCREENS.every((s) => s.label.trim().length > 0)).toBe(true);
    expect(SCREENS.every((s) => !!s.Icon)).toBe(true);            // a real lucide component
  });

  it("covers exactly the Screen union — a new screen can't ship unlabeled", () => {
    // This literal must enumerate every Screen key (a missing/extra one is a compile error),
    // and SCREENS must match it at runtime — so the rail nav + titlebar always have a name.
    const all: Record<Screen, true> = {
      console: true, projects: true, github: true, agents: true,
      mcp: true, skills: true, automation: true, settings: true,
    };
    expect(new Set(SCREENS.map((s) => s.key))).toEqual(new Set(Object.keys(all)));
  });

  it("screenLabel returns the canonical name, falling back to the raw key when unknown", () => {
    expect(screenLabel("console")).toBe("Console");
    expect(screenLabel("agents")).toBe("Security");      // Agents screen is labeled Security
    expect(screenLabel("automation")).toBe("Automations");
    expect(screenLabel("nonexistent" as Screen)).toBe("nonexistent");
  });
});
