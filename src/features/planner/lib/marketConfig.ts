// Market stage (#2430) — the pure data model behind the planner's market-research stage: the
// scored six-dimension rubric (problem severity × frequency × reachable market × competitive gap ×
// timing × moat), the competitor landscape, and the go/caution/no-go verdict. The planner produces
// the assessment by desk research only (never user polls) and records it with `bsc plan market set`
// (validated at write); the poll reflects the plan.db blob into `planMarketConfig`, and the
// `marketDefined` gate signal derives from it here. Pure (no React/Tauri) so it's unit-testable.
//
// The scoring RUBRIC (dimension labels/blurbs + per-blueprint-CATEGORY weights) is `@data`
// (`@data/market/rubric.json`, per the config-externalization standard #2027): greenfield weighs
// reachable-market/timing, transform/harden weigh severity/gap — the frontend computes the weighted
// total; the planner stores only the raw 1-5 scores.

import rubricEmbedded from "@data/market/rubric.json";
import { overlayFile } from "@/shared/lib/core/configOverrides";

/** The six rubric dimensions, in canonical display order. */
export const MARKET_DIMENSIONS = [
  "problemSeverity", "problemFrequency", "reachableMarket", "competitiveGap", "timing", "moat",
] as const;
export type MarketDimensionId = (typeof MARKET_DIMENSIONS)[number];

/** One scored rubric cell: an integer 1-5 with its rationale and ≥1 cited source (the citation
 *  discipline — every quantitative claim carries a fetched source, or the artifact is fiction). */
export interface MarketDimensionScore {
  score: number;
  rationale: string;
  sources: string[];
}

export type MarketRecommendation = "go" | "caution" | "no-go";

export interface MarketVerdict {
  recommendation: MarketRecommendation;
  rationale: string;
}

/** One competitor row of the landscape matrix (all fields but the name optional). */
export interface MarketCompetitor {
  name: string;
  pricing?: string;
  segment?: string;
  source?: string;
}

/** The `bsc plan market set` payload (#2430). `sizing` is a free key→value block (e.g. TAM/SAM/SOM
 *  figures) rendered generically; `null` from `bsc plan market get` means unset. */
export interface MarketConfig {
  summary: string;
  scores: Partial<Record<MarketDimensionId, MarketDimensionScore>>;
  sizing?: Record<string, string>;
  competitors?: MarketCompetitor[];
  verdict?: MarketVerdict;
}

// ── rubric (@data/market/rubric.json) ─────────────────────────────────────────

export interface MarketRubricDimension {
  id: string;
  label: string;
  blurb: string;
}

/** dimension id → weight (each category's table sums to 1). */
export type MarketWeights = Record<string, number>;

export interface MarketRubric {
  dimensions: MarketRubricDimension[];
  /** blueprint category (greenfield/transform/harden/maintain) → per-dimension weights. */
  weights: Record<string, MarketWeights>;
}

// The config-dir copy (#2047) overlays the embedded default — editable without a rebuild.
export const MARKET_RUBRIC: MarketRubric = overlayFile("market/rubric.json", rubricEmbedded as MarketRubric);

/** Resolve the weight table for a blueprint category; unknown/absent categories fall back to
 *  greenfield (the default lifecycle), then to equal weights so the total is always computable. */
export function marketWeights(category?: string): MarketWeights {
  const table = (category && MARKET_RUBRIC.weights[category]) || MARKET_RUBRIC.weights.greenfield;
  if (table) return table;
  return Object.fromEntries(MARKET_DIMENSIONS.map((id) => [id, 1 / MARKET_DIMENSIONS.length]));
}

/** The rubric's display metadata for one dimension (label/blurb), tolerant of a stale rubric file. */
export function marketDimensionMeta(id: MarketDimensionId): MarketRubricDimension {
  return MARKET_RUBRIC.dimensions.find((d) => d.id === id) ?? { id, label: id, blurb: "" };
}

// ── gate + scoring ────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** An integer 1..5 — the only valid rubric score. */
function validScore(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 5;
}

function validDimension(s: MarketDimensionScore | undefined): boolean {
  return !!s
    && validScore(s.score)
    && typeof s.rationale === "string" && s.rationale.trim().length > 0
    && Array.isArray(s.sources) && s.sources.some((src) => typeof src === "string" && src.trim().length > 0);
}

/**
 * The `marketDefined` gate signal (#2430): all six dimensions scored (integer 1-5, non-empty
 * rationale, ≥1 non-empty source each) and a verdict present. A defensive re-check of what
 * `bsc plan market set` validates at write — a stale/partial blob never clears the gate.
 */
export function marketDefined(cfg: MarketConfig | null | undefined): boolean {
  if (!cfg || !isRecord(cfg.scores)) return false;
  if (!MARKET_DIMENSIONS.every((id) => validDimension(cfg.scores[id]))) return false;
  const v = cfg.verdict;
  return !!v
    && (["go", "caution", "no-go"] as const).includes(v.recommendation)
    && typeof v.rationale === "string" && v.rationale.trim().length > 0;
}

/**
 * The 0-100 weighted total: the weighted mean of each valid dimension's score×20. Weights are
 * normalized over the dimensions actually scored (so a not-quite-1 weight sum never skews the
 * scale); an all-zero weight table falls back to an equal-weight mean. Unscored config → 0.
 */
export function weightedMarketScore(cfg: MarketConfig | null | undefined, weights: MarketWeights): number {
  if (!cfg || !isRecord(cfg.scores)) return 0;
  const scored = MARKET_DIMENSIONS.filter((id) => validScore(cfg.scores[id]?.score));
  if (scored.length === 0) return 0;
  const wsum = scored.reduce((acc, id) => acc + (weights[id] ?? 0), 0);
  const weightOf = (id: MarketDimensionId) => (wsum > 0 ? (weights[id] ?? 0) / wsum : 1 / scored.length);
  const total = scored.reduce((acc, id) => acc + weightOf(id) * cfg.scores[id]!.score * 20, 0);
  return Math.round(total);
}

/** One dimension's contribution (in points of the 0-100 total, assuming weights sum to 1) —
 *  the per-row "weighted contribution" figure the rubric table shows. */
export function marketContribution(cfg: MarketConfig | null | undefined, id: MarketDimensionId, weights: MarketWeights): number {
  const s = cfg?.scores?.[id];
  if (!s || !validScore(s.score)) return 0;
  return (weights[id] ?? 0) * s.score * 20;
}

/** Coerce the `bsc plan market get` blob into a typed config — a light structural check (the CLI
 *  validates hard at write); anything that isn't an object with a `scores` object is rejected. */
export function coerceMarketConfig(raw: unknown): MarketConfig | null {
  if (!isRecord(raw) || !isRecord(raw.scores)) return null;
  return raw as unknown as MarketConfig;
}
