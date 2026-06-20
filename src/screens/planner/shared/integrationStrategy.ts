import type { FlowPush } from "../fleet/agentFlow";

/** Fleet integration strategy (#378): a named preset that selects how workers integrate
 *  and how the director behaves. Chosen at the fleet level (project default) and
 *  overridable per stream. */
export type IntegrationStrategy = "self-merge" | "pr-ci" | "manual";
export type DirectorMode = "watchdog" | "integrator";
export type WorkerTest = "full" | "owned" | "none";

export const INTEGRATION_STRATEGIES: IntegrationStrategy[] = ["self-merge", "pr-ci", "manual"];
export const DEFAULT_STRATEGY: IntegrationStrategy = "self-merge";

export interface StrategySettings {
  /** What the worker runs before integrating. */
  test: WorkerTest;
  /** The worker push policy this strategy maps onto (a FlowPush value). */
  integrate: FlowPush;
  /** How the director behaves under this strategy. */
  director: DirectorMode;
}

export const STRATEGY_SETTINGS: Record<IntegrationStrategy, StrategySettings> = {
  "self-merge": { test: "full", integrate: "self-merge",  director: "watchdog" },
  "pr-ci":      { test: "full", integrate: "auto-pr",     director: "integrator" },
  "manual":     { test: "full", integrate: "commit-only", director: "integrator" },
};

/** Human label for a strategy (UI). */
export const STRATEGY_LABEL: Record<IntegrationStrategy, string> = {
  "self-merge": "Self-merge + watchdog",
  "pr-ci": "PR + CI gate",
  "manual": "Manual",
};

/** Coerce arbitrary input to a valid strategy or undefined. */
export function normalizeStrategy(v: unknown): IntegrationStrategy | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return (INTEGRATION_STRATEGIES as string[]).includes(t) ? (t as IntegrationStrategy) : undefined;
}

/** Resolve the effective strategy for a stream: per-stream override, else fleet default, else DEFAULT_STRATEGY. */
export function resolveStrategy(
  streamStrategy: IntegrationStrategy | undefined,
  fleetStrategy: IntegrationStrategy | undefined,
): IntegrationStrategy {
  return streamStrategy ?? fleetStrategy ?? DEFAULT_STRATEGY;
}

export function strategySettings(s: IntegrationStrategy): StrategySettings {
  return STRATEGY_SETTINGS[s];
}
