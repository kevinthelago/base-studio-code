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
 *  folded out, most-numerous first — so thirty `gm-<pid>-<tag>-<n>` entries read as one leaker. */
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

/**
 * Run `fn` with every temp variable pointing at a fresh per-run directory, then report what was left
 * in it and remove it — even when `fn` throws. The previous values are restored, so nothing after the
 * legs inherits a directory that no longer exists.
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
