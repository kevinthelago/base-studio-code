// In-process log-stream reads (#3630) — the perf-critical replacement for polling the unified log
// streams through the `bsc` bridge, which SPAWNED a `bsc.exe` subprocess per read (`console::bsc`).
// The always-on fleet/console pumps (`useCoordLog`, `useWorkerAutoEnd`, the pane-activity poll) hit
// these every ~1s; at 5–10 spawns/sec the Tauri invoke backlog grew without bound and the app froze.
// These native commands (`observability::logs::logs_*`) read the SAME files in-process via the `logs`
// crate — a file read, not a process — so the hot polls stop saturating the backend.
//
// Same JSON shape the `bsc logs …` subcommands emitted (the native commands return the same serde
// types), so these are drop-ins for the prior `bscJson(null, ["logs", …])` calls. Low-frequency
// `bsc logs …` reads (cost, analytics one-shots) stay on the `bsc` bridge.

import { safeInvoke } from "@/shared/lib/core/safeInvoke";

/** One pane's latest turn-boundary state — the `logs::PaneActivity` shape (`bsc logs pane-activity`). */
export interface PaneActivityRow {
  pane: string;
  state: string;
  at: number;
}

/**
 * Newest `limit` raw lines of a unified log stream (`coord`/`audit`/`skill`/`hook`/`mcp`/`ui`/…),
 * read in-process. `oldest` keeps chronological (oldest-first) order — pass `true` for the coord/ui
 * logs the replayers walk forward. An unknown/missing stream resolves to `fallback` (default `[]`);
 * pass `null` where a caller must distinguish "read failed → skip this tick" from an empty log.
 */
export function logsTail(stream: string, limit: number, oldest?: boolean): Promise<string[]>;
export function logsTail<F>(stream: string, limit: number, oldest: boolean, fallback: F): Promise<string[] | F>;
export function logsTail(stream: string, limit: number, oldest = false, fallback: unknown = []): Promise<unknown> {
  return safeInvoke("logs_tail", { stream, limit, oldest }, fallback);
}

/** The latest turn-boundary state per pane (`run`/`idle`), newest pane first — `bsc logs pane-activity`.
 *  Generic `T` lets a caller keep its own row type; the wire shape is always `{ pane, state, at }`. */
export function logsPaneActivity<T = PaneActivityRow>(): Promise<T[]> {
  return safeInvoke<T[]>("logs_pane_activity", undefined, []);
}

/** The deduped set of panes that self-reported `done` (#1379), newest first — `bsc logs done-panes`. */
export function logsDonePanes(): Promise<string[]> {
  return safeInvoke<string[]>("logs_done_panes", undefined, []);
}
