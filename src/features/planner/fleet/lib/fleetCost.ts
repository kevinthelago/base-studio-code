// Fleet cost & energy (#2237) — pure aggregation of per-pane token/cost telemetry over the live worker
// roster. COST is real (priced from each transcript's actual model by `bsc logs cost`); ENERGY is a
// clearly-labeled DIRECTIONAL ESTIMATE (tokens × a per-model-tier coefficient), never metered.
//
// The groupBy-and-total is the generic `groupTotals` (#3465) — the reusable "roll rows up per key +
// overall in one pass" algorithm this panel was a source for. The Wh-per-token energy estimate is
// likewise the generic `estimateEnergyWh` node (#3462, `llmEnergy.ts`) — this panel was its source,
// so the local copy is gone and it's delegated + re-exported (#3607).
import { groupTotals } from "@/shared/lib/algorithms/groupTotals";
import { estimateEnergyWh } from "@/shared/lib/algorithms/llmEnergy";

/** The per-pane rollup shape from `bsc logs cost --full` (subset used here; keys = the Rust struct). */
export interface TokenUsage {
  pane: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
}

/** Minimal roster shape — just the pane id + display name (LiveWorker is a superset). */
export interface CostWorkerLike { id: string; name: string }

export interface WorkerCost {
  id: string; name: string; model: string;
  input: number; output: number; cache: number; totalTokens: number;
  costUsd: number;
  /** Estimated Wh — directional, not metered. */
  energyWh: number;
}

export interface FleetCost {
  workers: WorkerCost[];
  totalTokens: number; totalInput: number; totalOutput: number; totalCache: number;
  totalCostUsd: number;
  /** Estimated total Wh (directional). */
  totalEnergyWh: number;
  byModel: Array<{ model: string; tokens: number; costUsd: number; energyWh: number }>;
  hasData: boolean;
}

// ── Energy estimate ────────────────────────────────────────────────────────────
// `estimateEnergyWh` is the generic algorithms-graph node (`llmEnergy.ts`, #3462): tokens × a
// per-model-tier coefficient, directional not metered. It's re-exported here so this panel and its
// test still resolve it from one place, while the single implementation lives in the graph (#3607).
export { estimateEnergyWh };

/** Average grid carbon intensity (kg CO₂ per kWh) — a rough global figure for the CO₂ estimate. */
export const CO2_KG_PER_KWH = 0.40;

/** Join per-pane usage to the live roster and roll up per-worker + fleet totals + a by-model split. */
export function aggregateFleetCost(workers: CostWorkerLike[], usage: Map<string, TokenUsage>): FleetCost {
  const list: WorkerCost[] = [];
  for (const w of workers) {
    const u = usage.get(w.id);
    if (!u) continue;
    const cache = u.cache_creation_tokens + u.cache_read_tokens;
    list.push({
      id: w.id, name: w.name, model: u.model,
      input: u.input_tokens, output: u.output_tokens, cache,
      totalTokens: u.input_tokens + u.output_tokens + cache,
      costUsd: u.cost_usd,
      energyWh: estimateEnergyWh(u.model, u.input_tokens, u.output_tokens),
    });
  }
  list.sort((a, b) => b.costUsd - a.costUsd);

  // The groupBy-by-model + every fleet total is the generic `groupTotals` (#3465), one pass over the
  // rolled-up rows — so a fleet total can never disagree with the sum of its per-model breakdown. The
  // JOIN + per-row rollup above (usage → worker cost) stays here: it is the app-specific projection,
  // and a graph algorithm cannot know a TokenUsage.
  const { totals, groups } = groupTotals(list, (c) => c.model, {
    totalTokens: (c) => c.totalTokens,
    totalInput: (c) => c.input,
    totalOutput: (c) => c.output,
    totalCache: (c) => c.cache,
    totalCostUsd: (c) => c.costUsd,
    totalEnergyWh: (c) => c.energyWh,
  });

  return {
    workers: list,
    ...totals,
    byModel: groups
      .map((g) => ({ model: g.key, tokens: g.totals.totalTokens, costUsd: g.totals.totalCostUsd, energyWh: g.totals.totalEnergyWh }))
      .sort((a, b) => b.costUsd - a.costUsd),
    hasData: list.length > 0,
  };
}
