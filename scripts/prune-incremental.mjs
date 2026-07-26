// Sweep orphaned incremental-compilation directories out of `target/*/incremental/` (#3821).
//
// The fs-touching half of the prune; the decision of WHAT to delete lives in the pure, unit-tested
// `incremental-prune-plan.mjs` (which also documents why these directories accumulate and why
// deleting them is safe — incremental state is a pure cache).
//
//   node scripts/prune-incremental.mjs [--days N] [--keep N] [--dry-run] [--quiet]
//
//     --days N     only prune directories untouched for N days (default 14)
//     --keep N     always spare the newest N per crate name (default 1)
//     --dry-run    report what would go, delete nothing
//     --quiet      print only when something was actually pruned
//
// FAIL-SAFE BY CONTRACT: this runs from `build:plan`, i.e. ahead of every `npm run tauri -- dev`.
// A cache janitor must never be able to block a dev launch, so every failure path is swallowed and
// the process always exits 0. The worst outcome of a bug here is that nothing gets cleaned.

import { readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { planPrune } from "./incremental-prune-plan.mjs";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const num = (flag, fallback) => {
    const i = argv.indexOf(flag);
    if (i === -1) return fallback;
    const n = Number(argv[i + 1]);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    days: num("--days", 14),
    keep: num("--keep", 1),
    dryRun: argv.includes("--dry-run"),
    quiet: argv.includes("--quiet"),
  };
}

/** Every `target/<profile>/incremental` that exists (debug, release, and any custom profile). */
async function incrementalDirs() {
  const targetDir = join(REPO_ROOT, "target");
  let profiles;
  try {
    profiles = await readdir(targetDir, { withFileTypes: true });
  } catch {
    return []; // no target/ yet — a fresh checkout has nothing to sweep
  }
  const found = [];
  for (const profile of profiles) {
    if (!profile.isDirectory()) continue;
    const dir = join(targetDir, profile.name, "incremental");
    try {
      if ((await stat(dir)).isDirectory()) found.push(dir);
    } catch {
      // profile has no incremental dir (e.g. a release build) — skip
    }
  }
  return found;
}

/** Directory names + mtimes under one `incremental/` dir. Unreadable entries are dropped, which
 *  makes them un-prunable — the conservative direction. */
async function entriesOf(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      found.push({ name: entry.name, mtimeMs: (await stat(join(dir, entry.name))).mtimeMs });
    } catch {
      // vanished mid-sweep or permission-denied — leave it alone
    }
  }
  return found;
}

async function main() {
  const { days, keep, dryRun, quiet } = parseArgs(process.argv.slice(2));
  let pruned = 0;
  let failed = 0;
  let scanned = 0;

  for (const dir of await incrementalDirs()) {
    const entries = await entriesOf(dir);
    scanned += entries.length;
    const { prune } = planPrune(entries, { days, keep });
    for (const name of prune) {
      if (dryRun) {
        pruned++;
        continue;
      }
      try {
        await rm(join(dir, name), { recursive: true, force: true });
        pruned++;
      } catch {
        failed++; // locked by a live build, or a Windows handle — try again next sweep
      }
    }
  }

  if (quiet && pruned === 0) return;
  const verb = dryRun ? "would prune" : "pruned";
  const tail = failed > 0 ? ` (${failed} could not be removed)` : "";
  console.log(
    `[prune-incremental] ${verb} ${pruned} of ${scanned} incremental dirs ` +
      `(untouched >${days}d, keeping newest ${keep} per crate)${tail}`,
  );
}

try {
  await main();
} catch (err) {
  // Never block a build on the janitor.
  console.warn(`[prune-incremental] skipped: ${err?.message ?? err}`);
}
