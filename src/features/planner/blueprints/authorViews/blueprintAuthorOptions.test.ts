import { describe, it, expect } from "vitest";
import options from "@data/planner/blueprint-author-options.json";

// Guard for the externalized Blueprint-Author Purpose options (@data/planner/blueprint-author-options.json, #2419).
describe("blueprint author options (loaded from @data/planner/blueprint-author-options.json)", () => {
  it("offers a unique, non-empty catalog-tag set", () => {
    expect(options.tags.length).toBeGreaterThan(0);
    expect(new Set(options.tags).size).toBe(options.tags.length);
    for (const t of options.tags) expect(t.trim().length).toBeGreaterThan(0);
  });

  it("offers unique accent hues, each a valid degree on the wheel", () => {
    expect(options.hueChoices.length).toBeGreaterThan(0);
    expect(new Set(options.hueChoices).size).toBe(options.hueChoices.length);
    for (const h of options.hueChoices) {
      expect(Number.isFinite(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });
});
