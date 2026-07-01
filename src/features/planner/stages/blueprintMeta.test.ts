import { describe, it, expect } from "vitest";
import { BLUEPRINT_CATEGORIES, CATEGORY_META } from "./blueprints";

// Guard for the externalized blueprint metadata (@data/planner/blueprint-meta.json, #2027 P1).
describe("blueprint metadata (loaded from @data/planner/blueprint-meta.json)", () => {
  it("loads the lifecycle categories + their display meta (keys aligned)", () => {
    expect(BLUEPRINT_CATEGORIES).toEqual(["greenfield", "transform", "harden", "maintain", "data"]);
    expect(CATEGORY_META.greenfield).toEqual({ label: "Greenfield", h: 145 });
    expect(CATEGORY_META.data).toEqual({ label: "Data", h: 280 });
    expect(Object.keys(CATEGORY_META).sort()).toEqual([...BLUEPRINT_CATEGORIES].sort());
  });
});
