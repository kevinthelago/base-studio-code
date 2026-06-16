// Planner eval harness — Tier-1 (#568 REL-tier1).
//
// Deterministic layer: rubric definition, per-run verdict aggregation, and
// pass-rate reporting. The non-deterministic parts (running the planner headlessly
// with a scripted user model, calling the judge) live outside this module and are
// NOT unit-tested — only the math is.
//
// Design: pin model + temperature, run K samples per scenario, assert that each
// rubric dimension's pass-rate meets its threshold. Dashboard-only (nightly/manual
// trigger) — NOT a per-PR blocking gate.

// ── Rubric ──────────────────────────────────────────────────────────────────────

/** One scored dimension of plan quality. */
export interface RubricDimension {
  id: string;
  /** Human-readable question the judge answers pass/fail. */
  question: string;
  /** Minimum fraction of K runs that must pass for this dimension (0–1). */
  threshold: number;
}

/**
 * Default rubric covering the four highest-leverage plan-quality dimensions.
 * All thresholds are set conservatively so early regressions surface clearly.
 */
export const DEFAULT_RUBRIC: RubricDimension[] = [
  {
    id: "issues_self_contained",
    question: "Are all issues self-contained — each has acceptance criteria and owns defined?",
    threshold: 0.8,
  },
  {
    id: "decomposition_coherent",
    question: "Is the decomposition coherent — no circular deps, no issues that are trivially duplicated?",
    threshold: 0.8,
  },
  {
    id: "fleet_partition_sensible",
    question: "Is the fleet partition sensible — streams are non-overlapping and dependencies are explicit?",
    threshold: 0.8,
  },
  {
    id: "context_complete",
    question: "Are all Context sections present, confirmed, and substantively filled in?",
    threshold: 0.9,
  },
];

// ── Per-run verdicts ─────────────────────────────────────────────────────────────

/**
 * The judge's output for one evaluation run: a pass/fail verdict per dimension.
 * Each key is a {@link RubricDimension.id}; true = pass, false = fail, absent = not evaluated.
 */
export interface RunVerdicts {
  verdicts: Record<string, boolean>;
}

// ── Aggregation ─────────────────────────────────────────────────────────────────

export interface DimensionScore {
  dimensionId: string;
  question: string;
  /** Fraction of runs where this dimension passed. */
  passRate: number;
  /** Number of runs that included a verdict for this dimension. */
  k: number;
  threshold: number;
  passed: boolean;
}

export interface PassRateReport {
  dimensions: DimensionScore[];
  /** True when every dimension meets its threshold. */
  passed: boolean;
  summary: string;
}

/**
 * Aggregate K run verdicts against a rubric and produce a pass-rate report.
 * Dimensions absent from all runs score 0 (treated as failing).
 */
export function aggregateRunScores(
  rubric: RubricDimension[],
  runs: RunVerdicts[],
): PassRateReport {
  const dimensions: DimensionScore[] = rubric.map((dim) => {
    const evaluated = runs.filter((r) => dim.id in r.verdicts);
    const k = evaluated.length;
    const passCount = evaluated.filter((r) => r.verdicts[dim.id] === true).length;
    const passRate = k > 0 ? passCount / k : 0;
    return {
      dimensionId: dim.id,
      question: dim.question,
      passRate,
      k,
      threshold: dim.threshold,
      passed: passRate >= dim.threshold,
    };
  });

  const failing = dimensions.filter((d) => !d.passed).map((d) => d.dimensionId);
  const passed = failing.length === 0;
  const summary = passed
    ? `All ${dimensions.length} dimension(s) pass across ${runs.length} run(s)`
    : `${failing.length} dimension(s) below threshold: ${failing.join(", ")}`;

  return { dimensions, passed, summary };
}

// ── Scenario aggregation ─────────────────────────────────────────────────────────

/** The K run results for one golden scenario (fixed pitch / repo set). */
export interface ScenarioResult {
  scenarioId: string;
  /** K run verdicts for this scenario. */
  runs: RunVerdicts[];
}

export interface ScenarioReport {
  scenarioId: string;
  report: PassRateReport;
}

export interface EvalReport {
  scenarios: ScenarioReport[];
  /** True when every scenario passes. */
  passed: boolean;
  summary: string;
}

/**
 * Build a dashboard-ready eval report across all scenarios, applying the same
 * rubric to each one's run verdicts.
 */
export function buildEvalReport(
  rubric: RubricDimension[],
  scenarios: ScenarioResult[],
): EvalReport {
  const scenarioReports: ScenarioReport[] = scenarios.map((s) => ({
    scenarioId: s.scenarioId,
    report: aggregateRunScores(rubric, s.runs),
  }));

  const failing = scenarioReports.filter((s) => !s.report.passed).map((s) => s.scenarioId);
  const passed = failing.length === 0;
  const summary = passed
    ? `All ${scenarios.length} scenario(s) pass`
    : `${failing.length} scenario(s) below threshold: ${failing.join(", ")}`;

  return { scenarios: scenarioReports, passed, summary };
}
