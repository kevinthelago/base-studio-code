import { describe, it, expect } from "vitest";
import {
  aggregateRunScores,
  buildEvalReport,
  DEFAULT_RUBRIC,
  type RunVerdicts,
  type RubricDimension,
  type ScenarioResult,
} from "../lib/planEval";

// ── aggregateRunScores ───────────────────────────────────────────────────────────

describe("aggregateRunScores", () => {
  const rubric: RubricDimension[] = [
    { id: "dim_a", question: "Does A pass?", threshold: 0.8 },
    { id: "dim_b", question: "Does B pass?", threshold: 0.5 },
  ];

  const allPass: RunVerdicts[] = Array.from({ length: 10 }, () => ({
    verdicts: { dim_a: true, dim_b: true },
  }));

  it("passes when all dimensions exceed their thresholds", () => {
    const r = aggregateRunScores(rubric, allPass);
    expect(r.passed).toBe(true);
    expect(r.dimensions.every(d => d.passed)).toBe(true);
  });

  it("computes pass rate as fraction of passing runs", () => {
    const mixed: RunVerdicts[] = [
      { verdicts: { dim_a: true, dim_b: false } },
      { verdicts: { dim_a: true, dim_b: false } },
      { verdicts: { dim_a: false, dim_b: true } },
      { verdicts: { dim_a: true, dim_b: true } },
    ];
    const r = aggregateRunScores(rubric, mixed);
    const a = r.dimensions.find(d => d.dimensionId === "dim_a")!;
    const b = r.dimensions.find(d => d.dimensionId === "dim_b")!;
    expect(a.passRate).toBeCloseTo(0.75);
    expect(a.k).toBe(4);
    expect(b.passRate).toBeCloseTo(0.5);
  });

  it("fails a dimension below threshold", () => {
    // dim_a threshold=0.8; 7/10 = 0.7 → below
    const runs: RunVerdicts[] = [
      ...Array.from({ length: 7 }, () => ({ verdicts: { dim_a: true, dim_b: true } })),
      ...Array.from({ length: 3 }, () => ({ verdicts: { dim_a: false, dim_b: true } })),
    ];
    const r = aggregateRunScores(rubric, runs);
    expect(r.passed).toBe(false);
    const a = r.dimensions.find(d => d.dimensionId === "dim_a")!;
    expect(a.passed).toBe(false);
    expect(r.summary).toMatch(/dim_a/);
  });

  it("passes a dimension exactly at its threshold", () => {
    // dim_a threshold=0.8; 8/10 = 0.8 → exactly at threshold → pass
    const runs: RunVerdicts[] = [
      ...Array.from({ length: 8 }, () => ({ verdicts: { dim_a: true, dim_b: true } })),
      ...Array.from({ length: 2 }, () => ({ verdicts: { dim_a: false, dim_b: true } })),
    ];
    const r = aggregateRunScores(rubric, runs);
    const a = r.dimensions.find(d => d.dimensionId === "dim_a")!;
    expect(a.passed).toBe(true);
    expect(a.passRate).toBeCloseTo(0.8);
  });

  it("scores a dimension 0 when absent from all runs", () => {
    const noVerdicts: RunVerdicts[] = [{ verdicts: {} }, { verdicts: {} }];
    const r = aggregateRunScores(rubric, noVerdicts);
    const a = r.dimensions.find(d => d.dimensionId === "dim_a")!;
    expect(a.passRate).toBe(0);
    expect(a.k).toBe(0);
    expect(a.passed).toBe(false);
  });

  it("counts only runs that include a verdict for each dimension (k per dimension)", () => {
    const partial: RunVerdicts[] = [
      { verdicts: { dim_a: true } },           // dim_b absent
      { verdicts: { dim_a: true, dim_b: true } },
      { verdicts: { dim_b: false } },           // dim_a absent
    ];
    const r = aggregateRunScores(rubric, partial);
    const a = r.dimensions.find(d => d.dimensionId === "dim_a")!;
    const b = r.dimensions.find(d => d.dimensionId === "dim_b")!;
    expect(a.k).toBe(2); // only 2 runs had dim_a
    expect(b.k).toBe(2); // only 2 runs had dim_b
  });

  it("handles zero runs gracefully", () => {
    const r = aggregateRunScores(rubric, []);
    expect(r.passed).toBe(false);
    expect(r.dimensions.every(d => d.passRate === 0 && d.k === 0)).toBe(true);
  });

  it("includes question text in dimension scores", () => {
    const r = aggregateRunScores(rubric, allPass);
    expect(r.dimensions[0].question).toBe("Does A pass?");
  });

  it("includes threshold in dimension scores", () => {
    const r = aggregateRunScores(rubric, allPass);
    expect(r.dimensions[0].threshold).toBe(0.8);
  });
});

// ── buildEvalReport ──────────────────────────────────────────────────────────────

describe("buildEvalReport", () => {
  const rubric: RubricDimension[] = [
    { id: "q", question: "Does Q pass?", threshold: 0.8 },
  ];

  const passingScenario = (id: string): ScenarioResult => ({
    scenarioId: id,
    runs: Array.from({ length: 5 }, () => ({ verdicts: { q: true } })),
  });

  const failingScenario = (id: string): ScenarioResult => ({
    scenarioId: id,
    runs: Array.from({ length: 5 }, () => ({ verdicts: { q: false } })),
  });

  it("passes when all scenarios pass", () => {
    const r = buildEvalReport(rubric, [passingScenario("s1"), passingScenario("s2")]);
    expect(r.passed).toBe(true);
    expect(r.scenarios).toHaveLength(2);
    expect(r.summary).toMatch(/All 2 scenario\(s\) pass/);
  });

  it("fails when any scenario fails", () => {
    const r = buildEvalReport(rubric, [passingScenario("s1"), failingScenario("s2")]);
    expect(r.passed).toBe(false);
    expect(r.summary).toMatch(/s2/);
  });

  it("returns per-scenario reports with scenario ids", () => {
    const r = buildEvalReport(rubric, [passingScenario("alpha"), failingScenario("beta")]);
    expect(r.scenarios.map(s => s.scenarioId).sort()).toEqual(["alpha", "beta"]);
    expect(r.scenarios.find(s => s.scenarioId === "alpha")!.report.passed).toBe(true);
    expect(r.scenarios.find(s => s.scenarioId === "beta")!.report.passed).toBe(false);
  });

  it("handles an empty scenario list", () => {
    const r = buildEvalReport(rubric, []);
    expect(r.passed).toBe(true); // vacuously true
    expect(r.scenarios).toHaveLength(0);
  });
});

// ── DEFAULT_RUBRIC ───────────────────────────────────────────────────────────────

describe("DEFAULT_RUBRIC", () => {
  it("has four dimensions covering issues, decomposition, fleet, and context", () => {
    const ids = DEFAULT_RUBRIC.map(d => d.id);
    expect(ids).toContain("issues_self_contained");
    expect(ids).toContain("decomposition_coherent");
    expect(ids).toContain("fleet_partition_sensible");
    expect(ids).toContain("context_complete");
  });

  it("all dimensions have thresholds in (0, 1]", () => {
    for (const d of DEFAULT_RUBRIC) {
      expect(d.threshold).toBeGreaterThan(0);
      expect(d.threshold).toBeLessThanOrEqual(1);
    }
  });

  it("works with aggregateRunScores", () => {
    const runs: RunVerdicts[] = DEFAULT_RUBRIC.map(d => ({
      verdicts: Object.fromEntries([[d.id, true]]),
    }));
    // One run per dimension, each passing its own dim → should pass overall
    // (k=1 for each dim in this setup, passing rate=1.0 for their own dim, 0 for others)
    // Actually each run only has one verdict, so k=1 for each dim and all pass.
    const r = aggregateRunScores(DEFAULT_RUBRIC, runs);
    expect(r.dimensions.every(d => d.k === 1)).toBe(true);
  });
});
