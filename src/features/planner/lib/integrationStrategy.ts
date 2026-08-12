import type { FlowPush } from "../fleet/agentFlow";

/** Fleet integration strategy (#378): a named preset that selects how workers integrate
 *  and how the director behaves. Chosen at the fleet level (project default) and
 *  overridable per stream. */
export type IntegrationStrategy = "local" | "self-merge" | "pr-ci" | "manual";
export type DirectorMode = "watchdog" | "integrator";
export type WorkerTest = "full" | "owned" | "none";

export const INTEGRATION_STRATEGIES: IntegrationStrategy[] = ["local", "self-merge", "pr-ci", "manual"];

/** `local` — the worker gates, commits on its branch and STOPS; the integration stream merges
 *  locally and nothing ever reaches a remote.
 *
 *  This is the default because the two prior candidates both wrote to a remote and neither said so
 *  at this layer: `self-merge` (the old default) pushes develop directly, and `pr-ci` pushes a
 *  branch and opens a PR. A project that has not chosen a strategy has not consented to either. */
export const DEFAULT_STRATEGY: IntegrationStrategy = "local";

export interface StrategySettings {
  /** What the worker runs before integrating. */
  test: WorkerTest;
  /** The worker push policy this strategy maps onto (a FlowPush value). */
  integrate: FlowPush;
  /** How the director behaves under this strategy. */
  director: DirectorMode;
}

export const STRATEGY_SETTINGS: Record<IntegrationStrategy, StrategySettings> = {
  // `local` keeps the integrator director on purpose: SOMETHING has to merge, and under this
  // strategy that is the integration stream, not the worker. A watchdog director (which only
  // watches develop's CI and reverts) would leave every completed branch unmerged forever.
  "local":      { test: "full", integrate: "local",       director: "integrator" },
  "self-merge": { test: "full", integrate: "self-merge",  director: "watchdog" },
  "pr-ci":      { test: "full", integrate: "auto-pr",     director: "integrator" },
  "manual":     { test: "full", integrate: "commit-only", director: "integrator" },
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
