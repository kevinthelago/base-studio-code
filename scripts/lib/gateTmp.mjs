// THE GATE'S TEMP DIRECTORY (`the-test-suites-leak-temp-dirs-into-tmp`).
//
// /tmp on this box is a 16 GB RAM-backed tmpfs, and the test suites leak into it: MEASURED 2026-09-11,
// ~30 sources across ~20 crates had left tens of thousands of entries behind — `gm-*` 6,930, `gmtt-*`
// 3,352, `bsc-confine-*` 3,009, `promote-check-cli-*` 1,627, `plandb-knownred-*` 1,064 (219 MB), and a
// long tail — until /tmp sat at 100% with swap full. A full tmpfs makes an UNRELATED test fail to load
// with ENOSPC, which is how it was found.
//
// Fixing each leaker is owed and happens test by test. This is what makes the gate stop adding to the
// pile meanwhile: every leg runs with TMPDIR/TMP/TEMP pointing at a per-run directory ON DISK, and the
// directory is removed when the legs finish, pass or fail. Before it goes, what was left in it is
// REPORTED by name, so a leaking test is visible in the gate output instead of silently filling RAM.
// Both toolchains honour the variable: node's `os.tmpdir()` and Rust's `std::env::temp_dir()`.
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Where per-run directories live. `/var/tmp` is on disk, not the tmpfs; Windows has no such split. */
export const GATE_TMP_BASE = process.platform === "win32" ? join(tmpdir(), "bsc-gate") : "/var/tmp/bsc-gate";

/** A run directory older than this is one a killed gate never removed, and the next gate sweeps it. */
export const STALE_RUN_MS = 6 * 60 * 60 * 1000;

const TEMP_VARS = ["TMPDIR", "TMP", "TEMP"];

/** The environment a leg needs so every temp file it makes lands in `dir`. */
export function tempEnv(dir) {
  return Object.fromEntries(TEMP_VARS.map((k) => [k, dir]));
}

/** What a run left behind, grouped by name with the per-run noise (pids, counters, random suffixes)
 *  folded out, most-numerous first — so thirty `gm-<pid>-<tag>-<n>` entries read as one leaker.
 *  @param {string} dir
 *  @returns {Leak[]} */
export function leakReport(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const groups = new Map();
  for (const name of names) {
    const key = name
      .replace(/ThreadId\(\d+\)/g, "ThreadId(N)")
      .replace(/-[A-Za-z0-9]{6}$/, "-RAND")
      .replace(/\d+/g, "N");
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** How many leak groups the gate names before it summarizes the rest. */
export const LEAK_REPORT_GROUPS = 20;

/** The one line the gate prints about what its legs left behind — every group up to `max`, and the
 *  count of what it did not name (`the-test-suites-still-leak-temp-entries-per-gate`). It used to be an
 *  inline `slice(0, 8)` with nothing after it: a full gate reported "507 entries" and named 76 of them,
 *  so the other 431 read as if they did not exist.
 *  @param {Leak[]} leaks
 *  @param {number} [max]
 *  @returns {string} */
export function formatLeakReport(leaks, max = LEAK_REPORT_GROUPS) {
  const total = leaks.reduce((n, l) => n + l.count, 0);
  const shown = leaks.slice(0, max);
  const rest = leaks.slice(max);
  const named = shown.map((l) => `${l.name} ×${l.count}`).join(" · ");
  const restCount = rest.reduce((n, l) => n + l.count, 0);
  const tail = rest.length
    ? ` · +${rest.length} more group${rest.length === 1 ? "" : "s"} (${restCount} entr${restCount === 1 ? "y" : "ies"})`
    : "";
  return `gate: the legs left ${total} temp entr${total === 1 ? "y" : "ies"} behind (removed): ${named}${tail}`;
}

/** Remove run directories under `base` older than `maxAgeMs` — the ones a killed gate left. */
export function sweepStaleGateTmp(base = GATE_TMP_BASE, maxAgeMs = STALE_RUN_MS, now = Date.now()) {
  let entries;
  try {
    entries = readdirSync(base);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    const path = join(base, name);
    try {
      if (now - statSync(path).mtimeMs > maxAgeMs) {
        rmSync(path, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      // Another gate removed it first, or it is not ours to stat — either way, not a failure.
    }
  }
  return removed;
}

/** @typedef {{ name: string, count: number }} Leak */

/**
 * Run `fn` with every temp variable pointing at a fresh per-run directory, then report what was left
 * in it and remove it — even when `fn` throws. The previous values are restored, so nothing after the
 * legs inherits a directory that no longer exists.
 *
 * @template T
 * @param {(dir: string) => Promise<T> | T} fn
 * @param {{ base?: string, report?: (leaks: Leak[]) => void, id?: string }} [options]
 * @returns {Promise<T>}
 */
export async function withGateTmp(fn, { base = GATE_TMP_BASE, report = () => {}, id = `${process.pid}-${Date.now()}` } = {}) {
  sweepStaleGateTmp(base);
  const dir = join(base, id);
  mkdirSync(dir, { recursive: true });
  const saved = Object.fromEntries(TEMP_VARS.map((k) => [k, process.env[k]]));
  Object.assign(process.env, tempEnv(dir));
  try {
    return await fn(dir);
  } finally {
    const leaks = leakReport(dir);
    if (leaks.length) report(leaks);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
