import { describe, it, expect } from "vitest";
import { findPlanGaps } from "../screens/projects/lintPlan";

describe("lintPlan — findPlanGaps", () => {
  it("flags empty files and unresolved placeholders", () => {
    expect(findPlanGaps({ "goal.md": "Ship the thing." })).toEqual([]);
    expect(findPlanGaps({ "goal.md": "   " })).toEqual(["goal.md: empty"]);
    expect(findPlanGaps({ "scope.md": "In scope: TODO" })[0]).toMatch(/unresolved placeholder/);
    expect(findPlanGaps({ "api.md": "describe the endpoints…" })[0]).toMatch(/unresolved placeholder/);
  });
  it("reports a gap per offending file", () => {
    const gaps = findPlanGaps({ "a.md": "", "b.md": "ok", "c.md": "TBD" });
    expect(gaps).toHaveLength(2);
  });
});
