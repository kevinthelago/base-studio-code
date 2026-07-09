import { describe, it, expect } from "vitest";
import departments from "@data/org/departments.json";
import { ROLE_META } from "./orgView";

// Guard for the externalized left-rail department order (@data/org/departments.json, #2419).
describe("org departments (loaded from @data/org/departments.json)", () => {
  it("is a unique list of non-empty names", () => {
    expect(departments.length).toBeGreaterThan(0);
    expect(new Set(departments).size).toBe(departments.length);
    for (const d of departments) {
      expect(typeof d).toBe("string");
      expect(d.trim().length).toBeGreaterThan(0);
    }
  });

  it("covers every department positionDisplay can assign (roles + the resource/external/team fallbacks)", () => {
    const assignable = new Set<string>([
      ...Object.values(ROLE_META).map((m) => m.dept),
      "Resource", "External", "Team", // non-agent kinds + the unknown-role fallback (orgView.ts)
    ]);
    for (const dept of assignable) expect(departments).toContain(dept);
  });
});
