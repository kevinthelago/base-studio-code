// The `bsc` bridge (epic #2114) — the UI drives the SAME complete `bsc` interaction set the project
// planner + agents use from a live session's shell, over ONE shared store surface, via the generic
// `bsc` Tauri command (#2115). This replaces the parallel, hand-maintained per-verb `plan_*`/`data_*`
// Tauri commands: `bsc plan …` / `bsc data …` route to the bundled binary's subcommand, and the Rust
// bridge wires the project's stores ($BSC_PLAN_DB/$BSC_DATA_DB from `projectKey`) + the global skills
// store, so the UI reaches parity with the planner — the user can make the same actions.
//
// The `bsc` subcommands emit JSON to stdout (structured reads) and return the same serde shapes the
// old per-verb commands did (both wrap the same store crates), so a migrated read parses to the exact
// same type. Kept React-free so it's unit-testable, mirroring safeInvoke.ts.

import { invoke } from "@tauri-apps/api/core";

/**
 * Run the bundled `bsc` CLI with `args` against `projectKey`'s stores; resolves to its raw stdout.
 * `projectKey` `null` (or empty) scopes to global-only subcommands (e.g. `bsc skill …`). Rejects when
 * the bundled binary can't be resolved or `bsc` exits non-zero (its stderr becomes the rejection).
 */
export async function bsc(projectKey: string | null, args: string[]): Promise<string> {
  return invoke<string>("bsc", { projectKey, args });
}

/**
 * Run `bsc` and JSON-parse its stdout as `T`; returns `fallback` when the output is empty (a void
 * verb) OR the invoke rejected (bridge/binary absent, or a project's plan.db not created yet). Mirrors
 * safeInvoke's degrade-gracefully contract, so a not-yet-existing store yields the fallback rather than
 * throwing — the same behavior the per-command `invoke(...).catch(() => fallback)` sites had.
 */
export async function bscJson<T>(projectKey: string | null, args: string[], fallback: T): Promise<T> {
  try {
    const out = (await bsc(projectKey, args)).trim();
    return out ? (JSON.parse(out) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Fire a `bsc` write/void verb and swallow any error (the bridge/store may be absent). */
export async function bscRun(projectKey: string | null, args: string[]): Promise<void> {
  try {
    await bsc(projectKey, args);
  } catch {
    /* bridge/store absent — ignore, matching the old per-command catch sites */
  }
}
