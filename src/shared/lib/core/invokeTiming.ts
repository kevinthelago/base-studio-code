// Invoke round-trip timing (#3626) — surfaces WHICH backend command is slow when the app feels laggy
// but the frontend `[perf]` line is clean (the signature of backend saturation delaying invokes; see
// [[perf-lag-diagnosis]]/[[fleet-gc-split-brain]]). Every `safeInvoke`/`fireInvoke`/`bsc` round-trip is
// timed; a call slower than `SLOW_INVOKE_MS` gets a `[invoke] <label> Nms` warn line in the app log's
// `perf` scope — the same file sink `log.warn(msg, "perf")` reaches.
//
// It writes STRAIGHT to `frontend_log` (not via `log`) on purpose: `log.ts` imports `safeInvoke`, so
// routing back through `log` would form a `safeInvoke ↔ log` import cycle in the lowest-level invoke
// path. Talking to the sink directly keeps that path cycle-free. The pure `slowInvokeLine` carries the
// threshold + format so it can be unit-tested with no Tauri/`log` dependency.

import { invoke } from "@tauri-apps/api/core";

/** A round-trip at/over this many ms is logged. 100ms ≈ "this call visibly stalled the caller". */
export const SLOW_INVOKE_MS = 100;

/** Commands never timed: the logging subsystem's own invokes. `frontend_log` is our sink (would be
 *  self-referential) and `log_get_scopes` is polled by `log.ts` — excluding both keeps the signal about
 *  app work, not about logging. Keyed by the real Tauri command, so `bsc …` labels are unaffected. */
const EXCLUDED = new Set(["frontend_log", "log_get_scopes"]);

/**
 * The `[invoke] <label> Nms` line for a call that took `ms`, or `null` when it's under threshold or the
 * `command` is excluded. Pure (no I/O) so the threshold/format is unit-testable.
 * @param label human-readable call label (the Tauri command, or `bsc <sub> <verb>` for the bsc bridge)
 * @param ms measured round-trip in milliseconds
 * @param command the real Tauri command, checked against the exclusion set (defaults to `label`)
 */
export function slowInvokeLine(label: string, ms: number, command: string = label): string | null {
  if (EXCLUDED.has(command)) return null;
  if (ms < SLOW_INVOKE_MS) return null;
  return `[invoke] ${label} ${Math.round(ms)}ms`;
}

/**
 * Start a round-trip timer; call the returned `stop()` in a `finally` so both fulfilled and rejected
 * invokes are measured. Emits a `[invoke]` warn line to the app-log `perf` scope when the call ran
 * `>= SLOW_INVOKE_MS`. Fire-and-forget — the sink write never blocks or throws into the caller.
 * @param label human-readable call label
 * @param command the real Tauri command for the exclusion check (defaults to `label`)
 */
export function startInvokeTimer(label: string, command: string = label): () => void {
  const t0 = performance.now();
  return () => {
    const line = slowInvokeLine(label, performance.now() - t0, command);
    if (line) void invoke("frontend_log", { level: "warn", scope: "perf", message: line }).catch(() => {});
  };
}

/** The `bsc <sub> <verb>` label for a bsc-bridge call — the first two args identify the subcommand,
 *  without logging (potentially large) positional/JSON payloads. */
export function bscLabel(args: string[]): string {
  const head = args.slice(0, 2).join(" ").trim();
  return head ? `bsc ${head}` : "bsc";
}
