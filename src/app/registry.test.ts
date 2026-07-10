import { describe, it, expect } from "vitest";
import { WORKSPACES, workspaceLabel, type Workspace } from "./registry";

describe("screen registry (#nav-pass)", () => {
  it("gives every screen a non-empty label, a unique key, and an icon", () => {
    const keys = WORKSPACES.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);                  // no duplicate keys
    expect(WORKSPACES.every((s) => s.label.trim().length > 0)).toBe(true);
    expect(WORKSPACES.every((s) => !!s.Icon)).toBe(true);            // a real lucide component
  });

  it("covers exactly the Workspace union — a new screen can't ship unlabeled", () => {
    // This literal must enumerate every Workspace key (a missing/extra one is a compile error),
    // and WORKSPACES must match it at runtime — so the rail nav + titlebar always have a name.
    const all: Record<Workspace, true> = {
      console: true, glance: true, algorithms: true, projects: true, github: true, security: true,
      mcp: true, skills: true, automation: true, settings: true,
    };
    expect(new Set(WORKSPACES.map((s) => s.key))).toEqual(new Set(Object.keys(all)));
  });

  it("workspaceLabel returns the canonical name, falling back to the raw key when unknown", () => {
    expect(workspaceLabel("console")).toBe("Console");
    expect(workspaceLabel("security")).toBe("Security");      // Agents screen is labeled Security
    expect(workspaceLabel("automation")).toBe("Automations");
    expect(workspaceLabel("nonexistent" as Workspace)).toBe("nonexistent");
  });
});
