// Sweep orphaned build artifacts out of `target/<profile>/deps`
// (#target-dirs-have-no-garbage-collector-except-for-incremental).
//
//   node scripts/sweep-target.mjs [--days N] [--keep N] [--dry-run] [--quiet]
//
//     --days N     only sweep units untouched for N days (default 3)
//     --keep N     always spare the newest N per crate name (default 3)
//     --root DIR   sweep DIR/target instead of this checkout's (default: the tree this script is in)
//     --dry-run    report what would go, delete nothing
//     --quiet      print only when something was actually swept
//
// `--root` exists because every worktree has its OWN target/ and the default is per-tree — correct
// for the `build:plan` hook, useless for sweeping the ten OTHER trees, which is where most of the
// 245 GB sits. It is also what makes this script verifiable against a tree that has real
// accumulation rather than one built today.
//
// ## Why this exists
//
// `target/` has no garbage collector. Three directories grow forever and only `incremental/` had a
// pruner. MEASURED on the main tree, 2026-08-16: 75 GB total, `deps/` ~27 GB of which 6.7 GB was
// 14+ days old, `.fingerprint/` 6939 dirs with 57 for `libduckdb-sys` alone going back to June 22.
// Across all ten trees, 245 GB.
//
// Every distinct `-C metadata` — feature set × profile × lib-vs-test × rustc version × dependency
// version — mints a NEW artifact and orphans the old one permanently. 1370 rlibs for 441 distinct
// crates; 8 copies of `libduckdb_sys` at 4.8 GB, four of them three weeks dead.
//
// ## The policy is NOT new
//
// `planPrune` (incremental-prune-plan.mjs) already encodes it: keep the newest K per crate name,
// and never touch anything younger than D days. It is pure and unit-tested. This script only
// converts `deps/`'s file families into the `<crate>-<hash>` entries that policy already parses
// (`target-units.mjs`); `.fingerprint/` dirs are already in that shape.
//
// ## The degradation, stated rather than discovered
//
// An `incremental/` dir is stamped whenever its crate builds, so mtime tracks liveness there. An
// rlib is NOT touched when merely LINKED — so a stable live dependency keeps an old mtime and can
// be swept, costing one rebuild of that unit. Bounded and never incorrect: cargo notices the
// missing output and regenerates it. `--keep` means the victim is almost always a dead variant.
// This trade was made deliberately; do not "fix" it by dropping the age floor to zero.
//
// ## `.fingerprint/` is deliberately NOT swept — measured, not assumed
//
// The first version swept it too, on the theory that it accumulates the same way. It does: 6939
// dirs, 57 for `libduckdb-sys` alone, back to June 22. But it is **22 MB**, against 24 GB in
// `deps/` — and deleting 5408 of those dirs made cargo treat their units as never-built and
// recompile **328 crates in 2m24s**. All cost, no benefit. A fingerprint dir is not rewritten when
// a fresh unit is merely re-checked, so its mtime is as poor a liveness signal as an rlib's, while
// the bytes it holds are rounding error. Leave it alone.
//
// FAIL-SAFE BY CONTRACT, same as the incremental pruner: this runs from `build:plan`, ahead of every
// `npm run tauri -- dev`. A cache janitor must never block a dev launch, so every failure path is
// swallowed and the process always exits 0. The worst outcome of a bug here is that nothing is swept.

import { readdir, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { planPrune } from "./incremental-prune-plan.mjs";
import { groupUnits } from "./target-units.mjs";

const DEFAULT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const num = (flag, fallback) => {
    const i = argv.indexOf(flag);
    if (i === -1) return fallback;
    const n = Number(argv[i + 1]);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const rootAt = argv.indexOf("--root");
  return {
    days: num("--days", 3),
    keep: num("--keep", 3),
    root: rootAt === -1 ? DEFAULT_ROOT : (argv[rootAt + 1] ?? DEFAULT_ROOT),
    dryRun: argv.includes("--dry-run"),
    quiet: argv.includes("--quiet"),
  };
}

/** Every `target/<profile>/<leaf>` that exists, for each build profile present. */
async function profileDirs(root, leaf) {
  const targetDir = join(root, "target");
  let profiles;
  try {
    profiles = await readdir(targetDir, { withFileTypes: true });
  } catch {
    return []; // no target/ yet — a fresh checkout has nothing to sweep
  }
  const found = [];
  for (const profile of profiles) {
    if (!profile.isDirectory()) continue;
    const dir = join(targetDir, profile.name, leaf);
    try {
      if ((await stat(dir)).isDirectory()) found.push(dir);
    } catch {
      // this profile has no such dir — skip
    }
  }
  return found;
}

/** `{name, mtimeMs}` for each direct child of `dir` matching `want` ("file" | "dir"). Unreadable
 *  entries are dropped, which makes them un-sweepable — the conservative direction. */
async function entriesOf(dir, want) {
  const found = [];
  let listing;
  try {
    listing = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of listing) {
    if (want === "dir" ? !entry.isDirectory() : !entry.isFile()) continue;
    try {
      found.push({ name: entry.name, mtimeMs: (await stat(join(dir, entry.name))).mtimeMs });
    } catch {
      // vanished mid-sweep or permission-denied — leave it alone
    }
  }
  return found;
}

/** Bytes of the named entries, best-effort — so the report is measured, not estimated. */
async function bytesOf(dir, names) {
  let total = 0;
  for (const name of names) {
    try {
      total += (await stat(join(dir, name))).size;
    } catch {
      // gone already; contributes nothing
    }
  }
  return total;
}

async function sweepDeps(opts) {
  let removed = 0;
  let bytes = 0;
  for (const dir of await profileDirs(opts.root, "deps")) {
    const units = groupUnits(await entriesOf(dir, "file"));
    const byKey = new Map(units.map((u) => [u.key, u]));
    const { prune } = planPrune(
      units.map((u) => ({ name: u.key, mtimeMs: u.mtimeMs })),
      { days: opts.days, keep: opts.keep }
    );
    for (const key of prune) {
      const unit = byKey.get(key);
      if (unit === undefined) continue;
      bytes += await bytesOf(dir, unit.files);
      if (opts.dryRun) {
        removed += 1;
        continue;
      }
      for (const file of unit.files) {
        try {
          await unlink(join(dir, file));
        } catch {
          // locked by a running process or already gone — the rest of the family still goes
        }
      }
      removed += 1;
    }
  }
  return { removed, bytes };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const deps = await sweepDeps(opts);
  const gb = (deps.bytes / 1073741824).toFixed(1);
  const verb = opts.dryRun ? "would sweep" : "swept";
  if (deps.removed || !opts.quiet) {
    console.log(
      `[sweep-target] ${verb} ${deps.removed} dep unit(s) (~${gb} GB) ` +
        `(untouched >${opts.days}d, keeping newest ${opts.keep} per crate)`
    );
  }
}

// Never block a dev launch: swallow everything and exit 0. See the contract note above.
main().catch((e) => {
  console.warn(`[sweep-target] skipped: ${e?.message ?? e}`);
});
