import { describe, it, expect } from "vitest";
import { PROJECT_MODES } from "./projectModes";

// #548 / #1876: the Projects page modes — formerly the `ProjectsPageModeStrip`, now the data behind
// the shared <Screen> tab bar (`PROJECT_MODES`, rendered in features/planner/index.tsx).
describe("Projects page modes (#548, #1876)", () => {
  it("offers Projects · Teams · Designs · Themes · Algorithms in that order", () => {
    // The Data Models page was archived with the data-platform panes (5def26b7, v1.0.5 prep).
    // Personas (#2094) was folded into the Team graph (#2199); Fleet analytics moved to Glance (#2223/#2228).
    // "Org" was renamed "Team"; the tab id was realigned "org" → "teams" too (#2700). Design Studio (#move-to-planner)
    // folded in from its standalone rail Workspace, renamed "Designs"; Themes (#themes-tab) split out of it.
    // Algorithms (#2785) folded in from its standalone rail Workspace too — a read-only knowledge graph.
    expect(PROJECT_MODES.map((m) => m.label)).toEqual(["Projects", "Teams", "Designs", "Themes", "Algorithms"]);
  });

  it("does not include the retired Blueprints / Summary / Data Models / Personas / Fleet modes", () => {
    // Blueprints folded into the Planner tab's blueprint rail; Summary moved to the GitHub screen;
    // Data Models archived with the data-platform panes (5def26b7); Personas folded into Org (#2199);
    // Fleet analytics moved to Glance (#2223/#2228).
    const labels = PROJECT_MODES.map((m) => m.label);
    expect(labels).not.toContain("Blueprints");
    expect(labels).not.toContain("Summary");
    expect(labels).not.toContain("Data Models");
    expect(labels).not.toContain("Personas");
    expect(labels).not.toContain("Fleet");
  });
});
