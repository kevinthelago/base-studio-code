import { describe, it, expect } from "vitest";
import { PROJECT_MODES } from "@/features/planner/list/projectModes";
import { WORKSPACES } from "@/app/registry";

// #548 / #1876: the Projects page modes — formerly the `ProjectsPageModeStrip`, now the data behind
// the shared <Screen> tab bar (`PROJECT_MODES`, rendered in features/planner/index.tsx).
describe("Projects page modes (#548, #1876)", () => {
  it("offers PROJECTS ALONE — every graph left for its own rail Workspace", () => {
    // The Planner had accumulated six tabs. Five of them were graphs folded in on the reasoning that
    // "a single read-only page needs no rail destination of its own" (Design Studio #move-to-planner,
    // Algorithms #2785, Teams #2199/#2700, Sounds #3072, Data). That is reversed by
    // `five-graphs-become-rail-workspaces`: the graphs ARE the app, so each is a rail destination and
    // the Planner keeps only what it is for — planning projects.
    expect(PROJECT_MODES.map((m) => m.label)).toEqual(["Projects"]);
  });

  it("every departed tab is reachable as a live Workspace, so nothing was merely deleted", () => {
    // The half that matters. Removing a tab whose destination does not exist would take the surface
    // away rather than move it — and it would look identical here, because this file only ever
    // asserted what the Planner offers.
    const live = new Set(WORKSPACES.map((w) => w.key as string));
    for (const key of ["components", "teams", "algorithms", "sounds", "data"]) {
      expect(live.has(key), `${key} left the Planner but is not a live Workspace`).toBe(true);
    }
  });

  it("does not include the retired Blueprints / Summary / Data Models / Personas / Fleet modes", () => {
    // Blueprints folded into the Planner tab's blueprint rail; Summary moved to the GitHub screen;
    // Data Models archived with the data-platform panes (5def26b7); Personas folded into Org (#2199);
    // Fleet analytics moved to Glance (#2223/#2228).
    const labels = PROJECT_MODES.map((m) => m.label);
    for (const gone of ["Blueprints", "Summary", "Data Models", "Personas", "Fleet"]) {
      expect(labels).not.toContain(gone);
    }
  });
});
