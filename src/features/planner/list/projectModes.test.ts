import { describe, it, expect } from "vitest";
import { PROJECT_MODES } from "@/features/planner/list/projectModes";

describe("PROJECT_MODES (#2850)", () => {
  it("has no standalone Themes tab — theme viewing folded into the Components preview (#2834)", () => {
    const ids = PROJECT_MODES.map((m) => m.id);
    expect(ids).not.toContain("themes");
    // `data` (the-data-graph-a-global-third-pillar) is the third pillar beside Components and
    // Algorithms — the global data graph, folded in as a tab for the same reason they were.
    expect(ids).toEqual(["projects", "teams", "designs", "algorithms", "sounds", "data"]);
  });

  it("Components stays keyed 'designs' (tear-off + persistence unaffected)", () => {
    expect(PROJECT_MODES.find((m) => m.id === "designs")?.label).toBe("Components");
  });
});
