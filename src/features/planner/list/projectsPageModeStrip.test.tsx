import { describe, it, expect } from "vitest";
import { PROJECT_MODES } from "./projectModes";

// #548 / #1876: the Projects page modes — formerly the `ProjectsPageModeStrip`, now the data behind
// the shared <Screen> tab bar (`PROJECT_MODES`, rendered in features/planner/index.tsx).
describe("Projects page modes (#548, #1876)", () => {
  it("offers Planner · Fleet · Data Models in that order", () => {
    expect(PROJECT_MODES.map((m) => m.label)).toEqual(["Planner", "Fleet", "Data Models"]);
  });

  it("does not include the retired Blueprints / Summary modes", () => {
    // Blueprints folded into the Planner tab's blueprint rail; Summary moved to the GitHub screen.
    const labels = PROJECT_MODES.map((m) => m.label);
    expect(labels).not.toContain("Blueprints");
    expect(labels).not.toContain("Summary");
  });
});
