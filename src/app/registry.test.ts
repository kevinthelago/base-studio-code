import { describe, it, expect } from "vitest";
import { WORKSPACES, workspaceLabel, effectiveWorkspace, type Workspace } from "@/app/registry";

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
      console: true, glance: true, projects: true, github: true, logs: true,
      settings: true,
      // The five GRAPHS (`five-graphs-become-rail-workspaces`).
      components: true, teams: true, algorithms: true, data: true, sounds: true,
    };
    expect(new Set(WORKSPACES.map((s) => s.key))).toEqual(new Set(Object.keys(all)));
  });

  it("workspaceLabel returns the canonical name, falling back to the raw key when unknown", () => {
    expect(workspaceLabel("console")).toBe("Console");
    expect(workspaceLabel("logs")).toBe("Logs");              // the Security/Agents screen became Logs
    expect(workspaceLabel("nonexistent" as Workspace)).toBe("nonexistent");
  });

  it("labels the five graphs by the names the rail and crumb show", () => {
    // `components` is the case worth pinning: the Planner TAB id was "designs" (the internal feature
    // name) while its LABEL was "Components" (#2818). The Workspace takes the label, so the key and
    // the old tab id deliberately differ — and `migrateGraphPage` maps designs → components because
    // of exactly this.
    expect(workspaceLabel("components")).toBe("Components");
    expect(workspaceLabel("teams")).toBe("Teams");
    expect(workspaceLabel("algorithms")).toBe("Algorithms");
    expect(workspaceLabel("data")).toBe("Data");
    expect(workspaceLabel("sounds")).toBe("Sounds");
  });

  it("keeps the five graphs together in rail order", () => {
    // Product-defined grouping: the graphs sit between the workflow destinations and the utilities.
    // Asserted as CONTIGUITY rather than exact indices so reordering within the group, or adding a
    // workflow screen above it, does not spuriously fail.
    const keys = WORKSPACES.map((s) => s.key);
    const graphs: Workspace[] = ["components", "teams", "algorithms", "data", "sounds"];
    const idx = graphs.map((k) => keys.indexOf(k));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect(Math.max(...idx) - Math.min(...idx)).toBe(idx.length - 1);
  });
});

describe("effectiveWorkspace — Console-page opt-in redirect (#2372/#3575)", () => {
  it("redirects console → glance only when the page toggle is off", () => {
    expect(effectiveWorkspace("console", false)).toBe("glance"); // page off → fall back to Glance
    expect(effectiveWorkspace("console", true)).toBe("console"); // page on  → stay on Console
  });

  it("passes every other workspace through, toggle regardless", () => {
    for (const raw of WORKSPACES.map((s) => s.key)) {
      if (raw === "console") continue;
      expect(effectiveWorkspace(raw, false)).toBe(raw);
      expect(effectiveWorkspace(raw, true)).toBe(raw);
    }
  });
});
