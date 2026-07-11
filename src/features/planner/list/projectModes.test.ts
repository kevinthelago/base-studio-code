import { describe, it, expect } from "vitest";
import { PROJECT_MODES } from "./projectModes";

describe("PROJECT_MODES (#2850)", () => {
  it("has no standalone Themes tab — theme viewing folded into the Components preview (#2834)", () => {
    const ids = PROJECT_MODES.map((m) => m.id);
    expect(ids).not.toContain("themes");
    expect(ids).toEqual(["projects", "teams", "designs", "algorithms"]);
  });

  it("Components stays keyed 'designs' (tear-off + persistence unaffected)", () => {
    expect(PROJECT_MODES.find((m) => m.id === "designs")?.label).toBe("Components");
  });
});
