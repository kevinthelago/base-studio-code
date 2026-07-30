import { describe, it, expect } from "vitest";
import {
  MARKET_DIMENSIONS, MARKET_RUBRIC, marketWeights, marketDimensionMeta,
  marketDefined, weightedMarketScore, marketContribution, coerceMarketConfig,
  type MarketConfig, type MarketDimensionScore,
} from "./marketConfig";

const dim = (over: Partial<MarketDimensionScore> = {}): MarketDimensionScore => ({
  score: 4, rationale: "cited desk research", sources: ["https://example.com/report"], ...over,
});

/** A fully-valid assessment (every dimension scored + verdict) — the shape `bsc plan market set` accepts. */
const fullConfig = (over: Partial<MarketConfig> = {}): MarketConfig => ({
  summary: "Incumbents underserve small teams; the gap is structural.",
  scores: Object.fromEntries(MARKET_DIMENSIONS.map((id) => [id, dim()])),
  verdict: { recommendation: "go", rationale: "Severe, frequent problem with a reachable wedge." },
  ...over,
});

describe("rubric data contract (@data/market/rubric.json)", () => {
  it("carries exactly the six canonical dimensions, in order", () => {
    expect(MARKET_RUBRIC.dimensions.map((d) => d.id)).toEqual([...MARKET_DIMENSIONS]);
    for (const d of MARKET_RUBRIC.dimensions) {
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.blurb.length).toBeGreaterThan(0);
    }
  });

  it("weighs every blueprint category over the six dimensions, summing to 1", () => {
    for (const cat of ["greenfield", "transform", "harden", "maintain"]) {
      const w = MARKET_RUBRIC.weights[cat];
      expect(w, `${cat} weights present`).toBeTruthy();
      expect(Object.keys(w).sort()).toEqual([...MARKET_DIMENSIONS].sort());
      expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    }
  });

  it("marketWeights resolves the category, falling back to greenfield for unknown/absent ones", () => {
    expect(marketWeights("transform")).toBe(MARKET_RUBRIC.weights.transform);
    expect(marketWeights("no-such-category")).toBe(MARKET_RUBRIC.weights.greenfield);
    expect(marketWeights(undefined)).toBe(MARKET_RUBRIC.weights.greenfield);
  });

  it("the `harvest` lifecycle has NO rubric row yet and degrades to greenfield weights (#4062)", () => {
    // Documented, not accidental. `harvest` was added to the lifecycle vocabulary for the L0 node
    // chip; what a data-extraction project's market assessment should WEIGH is a product judgement
    // that has not been made, and inventing one here would bury it. The fallback keeps the score
    // computable meanwhile. Give `harvest` its own row in rubric.json to change this.
    expect(MARKET_RUBRIC.weights.harvest).toBeUndefined();
    expect(marketWeights("harvest")).toBe(MARKET_RUBRIC.weights.greenfield);
  });

  it("marketDimensionMeta returns the rubric row (and a safe fallback for a stale rubric)", () => {
    expect(marketDimensionMeta("timing").label).toBe("Timing");
    expect(marketDimensionMeta("timing").blurb.length).toBeGreaterThan(0);
  });
});

describe("marketDefined — the gate signal (#2430)", () => {
  it("is false for null/undefined (unset in plan.db)", () => {
    expect(marketDefined(null)).toBe(false);
    expect(marketDefined(undefined)).toBe(false);
  });

  it("is true for a fully-scored assessment with a verdict", () => {
    expect(marketDefined(fullConfig())).toBe(true);
    for (const rec of ["go", "caution", "no-go"] as const) {
      expect(marketDefined(fullConfig({ verdict: { recommendation: rec, rationale: "r" } }))).toBe(true);
    }
  });

  it("requires ALL six dimensions", () => {
    const cfg = fullConfig();
    delete cfg.scores.moat;
    expect(marketDefined(cfg)).toBe(false);
  });

  it("rejects out-of-range and non-integer scores", () => {
    for (const bad of [0, 6, 3.5, -1, NaN]) {
      const cfg = fullConfig();
      cfg.scores.timing = dim({ score: bad });
      expect(marketDefined(cfg), `score ${bad}`).toBe(false);
    }
    for (const ok of [1, 5]) {
      const cfg = fullConfig();
      cfg.scores.timing = dim({ score: ok });
      expect(marketDefined(cfg), `score ${ok}`).toBe(true);
    }
  });

  it("requires a non-empty rationale per dimension", () => {
    const cfg = fullConfig();
    cfg.scores.competitiveGap = dim({ rationale: "   " });
    expect(marketDefined(cfg)).toBe(false);
  });

  it("requires ≥1 non-empty source per dimension (citation discipline)", () => {
    const empty = fullConfig();
    empty.scores.reachableMarket = dim({ sources: [] });
    expect(marketDefined(empty)).toBe(false);
    const blank = fullConfig();
    blank.scores.reachableMarket = dim({ sources: ["  "] });
    expect(marketDefined(blank)).toBe(false);
  });

  it("requires a verdict with a known recommendation and a rationale", () => {
    expect(marketDefined(fullConfig({ verdict: undefined }))).toBe(false);
    expect(marketDefined(fullConfig({ verdict: { recommendation: "maybe" as never, rationale: "r" } }))).toBe(false);
    expect(marketDefined(fullConfig({ verdict: { recommendation: "go", rationale: "" } }))).toBe(false);
  });
});

describe("weightedMarketScore — the 0-100 weighted total", () => {
  const equal = Object.fromEntries(MARKET_DIMENSIONS.map((id) => [id, 1 / 6]));

  it("maps the score band to 20-100 (all 1s → 20, all 5s → 100)", () => {
    const ones = fullConfig();
    for (const id of MARKET_DIMENSIONS) ones.scores[id] = dim({ score: 1 });
    expect(weightedMarketScore(ones, equal)).toBe(20);
    expect(weightedMarketScore(fullConfig(), equal)).toBe(80); // all 4s
    const fives = fullConfig();
    for (const id of MARKET_DIMENSIONS) fives.scores[id] = dim({ score: 5 });
    expect(weightedMarketScore(fives, equal)).toBe(100);
  });

  it("weighs dimensions per the table", () => {
    const cfg = fullConfig();
    for (const id of MARKET_DIMENSIONS) cfg.scores[id] = dim({ score: 3 });
    cfg.scores.problemSeverity = dim({ score: 5 });
    // Only severity + frequency carry weight: (0.5·100 + 0.5·60) = 80.
    const weights = { problemSeverity: 0.5, problemFrequency: 0.5 };
    expect(weightedMarketScore(cfg, weights)).toBe(80);
  });

  it("normalizes a weight table that doesn't sum to 1", () => {
    const cfg = fullConfig(); // all 4s → any normalized weighting of equal scores is 80
    const skewed = Object.fromEntries(MARKET_DIMENSIONS.map((id) => [id, 2]));
    expect(weightedMarketScore(cfg, skewed)).toBe(80);
  });

  it("falls back to an equal-weight mean when the table is all-zero, and to 0 when unscored", () => {
    expect(weightedMarketScore(fullConfig(), {})).toBe(80); // all 4s, equal fallback
    expect(weightedMarketScore(null, equal)).toBe(0);
    expect(weightedMarketScore({ summary: "", scores: {} }, equal)).toBe(0);
  });

  it("skips invalid scores rather than poisoning the total", () => {
    const cfg = fullConfig();
    cfg.scores.moat = dim({ score: 99 }); // invalid — skipped; the rest are 4s → still 80
    expect(weightedMarketScore(cfg, equal)).toBe(80);
  });
});

describe("marketContribution — the per-row points figure", () => {
  it("is weight × score × 20 for a valid row, 0 otherwise", () => {
    const cfg = fullConfig();
    expect(marketContribution(cfg, "timing", { timing: 0.15 })).toBeCloseTo(0.15 * 4 * 20);
    expect(marketContribution(cfg, "timing", {})).toBe(0);
    expect(marketContribution(null, "timing", { timing: 0.15 })).toBe(0);
  });
});

describe("coerceMarketConfig — the poll's read-path guard", () => {
  it("accepts an object with a scores object", () => {
    const cfg = coerceMarketConfig(fullConfig());
    expect(cfg?.summary).toContain("Incumbents");
  });

  it("rejects non-objects, arrays, and shapes without scores", () => {
    for (const bad of [null, undefined, 42, "x", [], { summary: "no scores" }, { scores: [] }]) {
      expect(coerceMarketConfig(bad)).toBeNull();
    }
  });
});
