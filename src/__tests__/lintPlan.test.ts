import { describe, it, expect } from "vitest";
import { findPlanGaps } from "../screens/planner/lintPlan";

describe("lintPlan — findPlanGaps", () => {
  it("flags empty files and the deliberate fill-in markers (TODO/TBD/FIXME/XXX/TKTK)", () => {
    expect(findPlanGaps({ "goal.md": "Ship the thing." })).toEqual([]);
    expect(findPlanGaps({ "goal.md": "   " })).toEqual(["goal.md: empty"]);
    expect(findPlanGaps({ "scope.md": "In scope: TODO" })[0]).toMatch(/unresolved placeholder/);
    expect(findPlanGaps({ "x.md": "decide later — FIXME" })[0]).toMatch(/unresolved placeholder/);
  });
  it("does NOT flag normal prose: ellipsis or the word 'placeholder' (#918 — they false-positived the gate)", () => {
    expect(findPlanGaps({ "api.md": "describe the endpoints…" })).toEqual([]);
    expect(findPlanGaps({ "ui.md": "loading, error, empty states, etc..." })).toEqual([]);
    expect(findPlanGaps({ "ux.md": "show a placeholder image until the data loads" })).toEqual([]);
  });
  it("reports a gap per offending file", () => {
    const gaps = findPlanGaps({ "a.md": "", "b.md": "ok", "c.md": "TBD" });
    expect(gaps).toHaveLength(2);
  });
});
