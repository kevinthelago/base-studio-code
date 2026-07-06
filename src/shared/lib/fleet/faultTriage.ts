// Runtime fault → routed fix loop (#2265, part of #2258). The PURE decision core that turns a project's
// unresolved runtime faults (read from `bsc errors list --unresolved --json`, the errordb store #2260)
// into a bounded, deduped set of fix DISPATCHES — the director then routes each via the existing
// coordination emitters `bsc-issue` (capture) → `bsc-assign` (route to a worker), and clears it on land
// with `bsc errors resolve <fingerprint>`.
//
// Kept React/Tauri-free so the three guarantees the acceptance turns on are unit-tested in isolation:
//   • GATE     — the per-project auto-triage toggle. OFF ⇒ surface-only, dispatch nothing.
//   • DEDUP    — never dispatch the same fingerprint twice while it stays open (idempotent per fault).
//   • RATE-LIMIT — a fault storm (N occurrences, or many faults at once) never exceeds the fan-out cap.
//
// The `useFaultTriage` hook is the thin poll+inject actuator over this; the maintenance/kickoff prose
// (director-protocol.md) primes the director to expect the injected fault and to resolve it on land.

import { clamp } from "@/shared/lib/core/math";

export type FaultLevel = "warn" | "error" | "fatal";

/** The minimal fault shape the triage core reads — a projection of the errordb `Fault` row (#2260). */
export interface FaultLite {
  fingerprint: string;
  level: FaultLevel;
  title: string;
  count: number;
  /** ms epoch when resolved; absent/null ⇒ open. (`--unresolved` lists only opens, but the fn is total
   *  over any list so a mixed list still behaves.) */
  resolvedAt?: number | null;
}

/** Per-project triage policy. `enabled` is the auto-triage toggle; the rest are the rate/severity knobs. */
export interface FaultTriageConfig {
  /** The per-project auto-triage toggle. `false` ⇒ surface-only (default): faults are shown, none routed. */
  enabled: boolean;
  /** Minimum occurrence `count` before a fault is worth routing a fix for. */
  threshold: number;
  /** Minimum severity to route (below it, surface-only). */
  minLevel: FaultLevel;
  /** Fan-out cap: at most this many concurrently dispatched-but-still-open fixes for the project. */
  maxInFlight: number;
  /** Storm guard: at most this many NEW dispatches emitted in a single poll cycle. */
  maxPerCycle: number;
}

/** The default knobs (the toggle itself defaults OFF, supplied separately per project). Conservative:
 *  error+ only, a small fan-out, ≤2 new fixes per cycle — a storm can't spawn a fleet. */
export const DEFAULT_FAULT_TRIAGE: Omit<FaultTriageConfig, "enabled"> = {
  threshold: 1,
  minLevel: "error",
  maxInFlight: 3,
  maxPerCycle: 2,
};

/** One fault chosen for routing this cycle. */
export interface FaultDispatch {
  fingerprint: string;
  level: FaultLevel;
  title: string;
  count: number;
}

export interface FaultTriagePlan {
  /** Faults to route THIS cycle (the director captures + assigns one fix each). */
  dispatch: FaultDispatch[];
  /** The fingerprints now considered handled — carry this back in as `dispatched` next cycle. Pruned to
   *  still-open faults, so a resolved fault drops out (freeing its fan-out slot) and a later recurrence
   *  re-dispatches. */
  nextDispatched: string[];
}

const LEVEL_RANK: Record<FaultLevel, number> = { warn: 1, error: 2, fatal: 3 };
function rank(l: FaultLevel): number {
  return LEVEL_RANK[l] ?? 0;
}

/**
 * Decide which unresolved faults to route this poll cycle. Pure + deterministic.
 *
 * @param faults      the project's fault list (typically `bsc errors list --unresolved --json`).
 * @param dispatched  fingerprints already routed in prior cycles (the dedup ledger; carry `nextDispatched`).
 * @param cfg         the per-project policy (gate + rate/severity knobs).
 *
 * Guarantees:
 *  - GATE: `cfg.enabled === false` ⇒ `dispatch` is empty (surface-only).
 *  - DEDUP: a fingerprint already in `dispatched` (and still open) is never re-dispatched.
 *  - RATE-LIMIT: `dispatch.length ≤ maxPerCycle` AND `inFlight + dispatch.length ≤ maxInFlight`.
 */
export function planFaultDispatch(
  faults: FaultLite[],
  dispatched: Iterable<string>,
  cfg: FaultTriageConfig,
): FaultTriagePlan {
  const already = new Set(dispatched);
  const open = faults.filter((f) => !f.resolvedAt);
  const openFps = new Set(open.map((f) => f.fingerprint));

  // Prune the dedup ledger to fingerprints that are still open. A resolved (or aged-out) fault drops out
  // — this is the resolve→clear path: clearing a fault frees its fan-out slot and lets a genuine
  // recurrence (errordb re-opens the same fingerprint) re-dispatch.
  const pruned = [...already].filter((fp) => openFps.has(fp));

  // GATE: toggle OFF ⇒ surface only. Still return the pruned ledger so turning it on later doesn't
  // re-dispatch faults resolved while it was off.
  if (!cfg.enabled) return { dispatch: [], nextDispatched: pruned };

  // In-flight = dispatched fingerprints still open (fixes routed but not yet resolved). `pruned` is
  // exactly `already ∩ open`, so its size is the live fan-out.
  const inFlight = pruned.length;
  const slots = clamp(cfg.maxInFlight - inFlight, 0, cfg.maxPerCycle);
  if (slots === 0) return { dispatch: [], nextDispatched: pruned };

  const minRank = rank(cfg.minLevel);
  const candidates = open
    .filter((f) => !already.has(f.fingerprint) && f.count >= cfg.threshold && rank(f.level) >= minRank)
    // Worst first (so under a cap the most severe/frequent faults win the slots): severity, then volume,
    // then fingerprint for a stable, deterministic order.
    .sort((a, b) =>
      rank(b.level) - rank(a.level) || b.count - a.count || a.fingerprint.localeCompare(b.fingerprint),
    );

  const chosen = candidates.slice(0, slots);
  return {
    dispatch: chosen.map((f) => ({ fingerprint: f.fingerprint, level: f.level, title: f.title, count: f.count })),
    nextDispatched: [...pruned, ...chosen.map((f) => f.fingerprint)],
  };
}

/** Count of unresolved faults in a list — the number the Glance node fault-badge shows. */
export function unresolvedCount(faults: FaultLite[]): number {
  return faults.reduce((n, f) => (f.resolvedAt ? n : n + 1), 0);
}

/** The director-facing message routing this cycle's faults. One paste covers the batch; the director
 *  runs the emitters (`bsc-issue` → `bsc-assign`) per its protocol and resolves each on land. */
export function faultDispatchPrompt(dispatch: FaultDispatch[]): string {
  const lines = dispatch
    .map((d) => `• [${d.level} · ${d.count}×] ${d.title} (fp ${d.fingerprint})`)
    .join("\n");
  return [
    "[fault-triage] New runtime fault(s) crossed the auto-triage threshold — route a fix for each:",
    lines,
    "For each fault: capture it with `bsc-issue` (a well-formed title + the detail from " +
      "`bsc errors get <fingerprint>`), then `bsc-assign <session>` the worker in whose `owns` lane the " +
      "fault lives (open a GitHub issue first if it should be tracked). When the fix merges to develop, " +
      "clear it: `bsc errors resolve <fingerprint>`.",
  ].join("\n");
}
