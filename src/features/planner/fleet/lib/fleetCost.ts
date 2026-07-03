// Fleet cost & energy (#2237) — pure aggregation of per-pane token/cost telemetry over the live worker
// roster. COST is real (priced from each transcript's actual model by `bsc logs cost`); ENERGY is a
// clearly-labeled DIRECTIONAL ESTIMATE (tokens × a per-model-tier coefficient), never metered.

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
// Rough Wh per 1k tokens by model tier. Output generation dominates energy; input/cache are cheaper.
// These are ORDER-OF-MAGNITUDE constants for a directional estimate — NOT a measurement. Tune freely.
const WH_PER_1K: Record<"large" | "medium" | "small" | "local", { in: number; out: number }> = {
  large: { in: 0.05, out: 0.9 },   // Opus / GPT-4-class frontier models
  medium: { in: 0.03, out: 0.4 },  // Sonnet / GPT-4o / Gemini-Pro-class
  small: { in: 0.01, out: 0.15 },  // Haiku / mini / flash
  local: { in: 0, out: 0 },        // local models — no cloud energy attributed
};

/** Average grid carbon intensity (kg CO₂ per kWh) — a rough global figure for the CO₂ estimate. */
export const CO2_KG_PER_KWH = 0.40;

function tier(model: string): keyof typeof WH_PER_1K {
  const m = model.toLowerCase();
  if (/local|ollama|llama|mistral|qwen|deepseek|phi/.test(m)) return "local";
  if (/opus|ultra|gpt-4(?!o)|gpt4(?!o)/.test(m)) return "large";
  if (/haiku|mini|flash|nano|small|lite/.test(m)) return "small";
  return "medium"; // sonnet / gpt-4o / gemini-pro / unknown hosted → Sonnet-class
}

/** Estimated Wh for an input/output token split at the model's tier. Directional, not metered. */
export function estimateEnergyWh(model: string, inputTokens: number, outputTokens: number): number {
  const k = WH_PER_1K[tier(model)];
  return (inputTokens / 1000) * k.in + (outputTokens / 1000) * k.out;
}

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

  const byModelMap = new Map<string, { model: string; tokens: number; costUsd: number; energyWh: number }>();
  for (const c of list) {
    const e = byModelMap.get(c.model) ?? { model: c.model, tokens: 0, costUsd: 0, energyWh: 0 };
    e.tokens += c.totalTokens; e.costUsd += c.costUsd; e.energyWh += c.energyWh;
    byModelMap.set(c.model, e);
  }

  const sum = (f: (c: WorkerCost) => number) => list.reduce((a, c) => a + f(c), 0);
  return {
    workers: list,
    totalTokens: sum((c) => c.totalTokens),
    totalInput: sum((c) => c.input),
    totalOutput: sum((c) => c.output),
    totalCache: sum((c) => c.cache),
    totalCostUsd: sum((c) => c.costUsd),
    totalEnergyWh: sum((c) => c.energyWh),
    byModel: [...byModelMap.values()].sort((a, b) => b.costUsd - a.costUsd),
    hasData: list.length > 0,
  };
}
