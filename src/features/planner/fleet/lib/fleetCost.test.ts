// fleetCost (#2237) — cost aggregation (real) + energy estimate (directional).
import { describe, it, expect } from "vitest";
import { aggregateFleetCost, estimateEnergyWh, type TokenUsage } from "./fleetCost";
import { estimateEnergyWh as graphEstimateEnergyWh } from "@/shared/lib/algorithms/llmEnergy";

const usage = (over: Partial<TokenUsage> & { pane: string }): TokenUsage => ({
  model: "claude-sonnet-4-6", input_tokens: 0, output_tokens: 0,
  cache_creation_tokens: 0, cache_read_tokens: 0, cost_usd: 0, ...over,
});

describe("aggregateFleetCost (#2237)", () => {
  it("joins usage to the roster by pane id and rolls up totals + by-model", () => {
    const workers = [{ id: "p1", name: "w1" }, { id: "p2", name: "w2" }, { id: "p3", name: "w3" }];
    const map = new Map<string, TokenUsage>([
      ["p1", usage({ pane: "p1", input_tokens: 1000, output_tokens: 500, cost_usd: 0.1, model: "claude-opus-4-8" })],
      ["p2", usage({ pane: "p2", input_tokens: 2000, output_tokens: 1000, cache_read_tokens: 500, cost_usd: 0.2, model: "claude-sonnet-4-6" })],
      // p3 has no recorded usage → dropped
    ]);
    const c = aggregateFleetCost(workers, map);
    expect(c.hasData).toBe(true);
    expect(c.workers).toHaveLength(2);
    expect(c.totalCostUsd).toBeCloseTo(0.3, 6);
    expect(c.totalTokens).toBe(1000 + 500 + 2000 + 1000 + 500);
    expect(c.byModel).toHaveLength(2);
    expect(c.totalEnergyWh).toBeGreaterThan(0);
    // sorted by cost desc — p2 ($0.20) before p1 ($0.10).
    expect(c.workers[0].id).toBe("p2");
  });

  it("no matching usage → empty (no fabricated numbers)", () => {
    const c = aggregateFleetCost([{ id: "x", name: "x" }], new Map());
    expect(c.hasData).toBe(false);
    expect(c.totalCostUsd).toBe(0);
    expect(c.totalEnergyWh).toBe(0);
  });
});

describe("estimateEnergyWh (#2237)", () => {
  it("estimates a larger model as more energy for the same tokens", () => {
    expect(estimateEnergyWh("claude-opus-4-8", 1000, 1000)).toBeGreaterThan(estimateEnergyWh("claude-haiku-4-5", 1000, 1000));
  });
  it("attributes ~no cloud energy to local models", () => {
    expect(estimateEnergyWh("ollama/llama3", 5000, 5000)).toBe(0);
  });
  it("delegates to the llmEnergy graph node — no second local copy (#3607)", () => {
    // The re-export IS the graph node; a regression that reintroduces a local copy breaks this.
    expect(estimateEnergyWh).toBe(graphEstimateEnergyWh);
  });
});
