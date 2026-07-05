// Unified frontend logger — routed through the runtime log-scope graph (#1389).
//
// Two sinks, split by POLICY (mirroring the backend `GraphLogger`):
//   1. FILE — always. Every call forwards to the `frontend_log` command, which routes through the
//      backend GraphLogger so the record is ALWAYS audited to the rotating app-log file. This is the
//      security property: an agent/dev can quiet the console VIEW but can never suppress the record.
//   2. DEVTOOLS CONSOLE — a view, gated per feature scope by the synced scope registry
//      (`log_get_scopes`). A scope toggled off/below-level silences its devtools output; the file
//      record is unaffected.
//
// The backend hop is DEFERRED (#1033): the `invoke` never fires synchronously inside a logging call
// (which could land in a render/PTY hot path during cold start). Calls are queued and drained on a
// short debounced timer, off the caller's stack. The console output stays immediate.

import { invoke } from "@tauri-apps/api/core";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";

/** A frontend log level. Ranks mirror the backend (`log::Level`): error=1 … debug=4. */
type Level = "error" | "warn" | "info" | "debug";

const LEVEL_RANK: Record<Level, number> = { error: 1, warn: 2, info: 3, debug: 4 };

/** The app crate's log-target root — frontend records are namespaced beneath it so they join the
 *  ONE scope tree the backend + `bsc log` share. Keep in sync with `logs::scope::CRATE_ROOT`. */
const CRATE_ROOT = "base_studio_code_lib";

/** The default feature scope when a caller doesn't name one. */
const DEFAULT_SCOPE = "core";

/** How long (ms) to coalesce queued backend-sink writes before draining them. */
const FLUSH_MS = 250;
/** How stale (ms) the cached scope config may get before a lazy background refresh. */
const SCOPES_TTL_MS = 5_000;

/** The full `::`-joined target for a frontend feature scope (`…::frontend::planner`). */
function targetFor(scope: string): string {
  const leaf = scope.trim();
  return leaf ? `${CRATE_ROOT}::frontend::${leaf}` : `${CRATE_ROOT}::frontend`;
}

// ── Synced scope registry (the devtools-console gate) ────────────────────────────────────────────
// A local mirror of the backend scope graph (`log_get_scopes`), refreshed lazily. Seeded with the
// backend defaults (root=warn, app crate=info) so behavior pre-fetch matches post-fetch.

const scopeThreshold: Map<string, number> = new Map([
  ["", LEVEL_RANK.warn],
  [CRATE_ROOT, LEVEL_RANK.info],
]);
let scopesFetchedAt = 0;

/** Map a backend level label to a rank; `off` → 0 (never shows). */
function labelRank(label: string): number {
  if (label === "off") return 0;
  return (LEVEL_RANK as Record<string, number>)[label] ?? LEVEL_RANK.warn;
}

/** Refresh the cached scope graph from the backend (fire-and-forget; degrades to the current cache). */
async function refreshScopes(): Promise<void> {
  scopesFetchedAt = Date.now();
  const nodes = await safeInvoke<{ scope: string; level: string }[]>("log_get_scopes", undefined, []);
  if (!Array.isArray(nodes) || nodes.length === 0) return;
  scopeThreshold.clear();
  for (const n of nodes) scopeThreshold.set(n.scope, labelRank(n.level));
}

/** Whether a record at `scope`/`levelRank` passes the devtools-console gate: the longest scope key
 *  that prefix-matches the target governs (cascade to subtree), mirroring `ScopeConfig::console_level`. */
function consolePermits(scope: string, levelRank: number): boolean {
  // Kick a lazy refresh when the cache is stale (never blocks the log call).
  if (Date.now() - scopesFetchedAt > SCOPES_TTL_MS) void refreshScopes();

  const target = targetFor(scope);
  let bestLen = -1;
  let threshold = LEVEL_RANK.warn; // floor if nothing matches (root is usually present)
  for (const [key, rank] of scopeThreshold) {
    const matches = key === "" || target === key || target.startsWith(`${key}::`);
    if (matches && key.length > bestLen) {
      bestLen = key.length;
      threshold = rank;
    }
  }
  return threshold > 0 && levelRank <= threshold;
}

// ── The deferred backend queue (#1033) ───────────────────────────────────────────────────────────

const queue: { level: Level; scope: string; message: string }[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function drain(): void {
  flushTimer = null;
  const batch = queue.splice(0, queue.length);
  // Fire-and-forget, in order; swallow failures so logging never breaks flow.
  for (const { level, scope, message } of batch) {
    void invoke("frontend_log", { level, scope, message }).catch(() => { /* backend unavailable */ });
  }
}

function scheduleFlush(): void {
  if (flushTimer === null) flushTimer = setTimeout(drain, FLUSH_MS);
}

const consoleFn: Record<Level, (...args: unknown[]) => void> = {
  error: console.error,
  warn: console.warn,
  info: console.info,
  debug: console.debug,
};

function route(level: Level, message: string, scope: string): void {
  // FILE sink — ALWAYS (the security property): queue the deferred backend hop.
  queue.push({ level, scope, message });
  scheduleFlush();
  // DEVTOOLS CONSOLE sink — gated per scope by the synced registry.
  if (consolePermits(scope, LEVEL_RANK[level])) consoleFn[level](message);
}

/**
 * The app logger. Every call is audited to the file sink; the devtools-console output is gated per
 * feature `scope` (default `"core"`) by the runtime scope graph — so `bsc log set frontend::planner
 * off` or the graph UI can quiet a feature's console noise without losing the audit record.
 */
export const log = {
  debug: (message: string, scope: string = DEFAULT_SCOPE) => route("debug", message, scope),
  info:  (message: string, scope: string = DEFAULT_SCOPE) => route("info", message, scope),
  warn:  (message: string, scope: string = DEFAULT_SCOPE) => route("warn", message, scope),
  error: (message: string, scope: string = DEFAULT_SCOPE) => route("error", message, scope),
};
