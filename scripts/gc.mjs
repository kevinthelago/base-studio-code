// The ONE garbage-collection entry point for a build tree (#the-gc-never-runs-where-the-garbage-is).
//
//   node scripts/gc.mjs [--force] [--dry-run] [--quiet] [--days N] [--keep N]
//
//     --force      sweep even if this tree was swept inside the stamp window
//     --dry-run    report what would go, delete nothing (implies --force)
//     --quiet      print only when something was actually reclaimed
//     --days/--keep  passed through to both sweeps
//
// ## The bug this exists to fix
//
// The two sweeps were correct and tested, and they never ran. Both hung off `build:plan`, which is
// invoked only by `beforeDevCommand` in tauri.conf.json — that is, by `npm run tauri -- dev`. A
// worktree agent runs `npm run gate` and `cargo`; it never runs `tauri dev`. So the ONLY tree ever
// swept was the one where the app gets launched, which is exactly the tree that accumulated two
// months of orphans (75 GB, 8 copies of libduckdb_sys, fingerprint dirs back to June 22). The
// worktrees — the trees the fleet actually works in — had never been swept once. They audited clean
// only because they were young.
//
// The policy was never the problem. WHERE IT WAS ATTACHED was.
//
// ## Why one entry point
//
// There were three janitor scripts with three flag sets and three report formats, and a fourth was
// planned. A caller should not have to know which of them covers which directory. `gc` is the name
// the gate and `build:plan` both call; the individual scripts remain the implementations and stay
// runnable on their own for targeted work (`--root` against another tree, for instance).
//
// The DESTRUCTIVE worktree cap is deliberately not part of this. These sweeps' worst outcome is a
// rebuild; removing a working tree is a different kind of act and stays an explicit command.
//
// ## The stamp
//
// The gate runs constantly during iteration, and 1.5s of sweeping on every run is a tax for nothing
// — a tree cannot accrue meaningful garbage in the minutes between two gate runs. So a stamp file
// records the last sweep and the run is skipped inside the window. It lives in `target/` because it
// describes that tree's build output: per-tree, disposable, and destroyed by `cargo clean` along
// with the thing it describes.
//
// FAIL-SAFE BY CONTRACT: this runs from the GATE and from `build:plan`. It must never fail either
// one, so every path is swallowed and the process always exits 0. A janitor that can redden a gate
// would be worse than the garbage it collects.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STAMP = join(REPO_ROOT, "target", ".bsc-gc-stamp");

/** How long a sweep counts as recent.
 *
 *  THE INVARIANT IS THAT THIS STAYS UNDER THE AGE FLOOR the sweeps use, so nothing can become eligible
 *  and sit unswept for longer than the floor plus this. It held at a 1-day window against a 3-day
 *  floor; when the floor came down to six hours (see `prune-incremental`, which was a no-op at three
 *  days) a 1-day window would have inverted it — the sweep would have been skipped for four times
 *  longer than a directory takes to become eligible, and the collection this exists to do would have
 *  happened once a day at best.
 *
 *  One hour: frequent enough that eligibility never outlives it, and the sweep costs ~1.5s, so the tax
 *  on a gate that runs constantly during iteration stays negligible. */
const STAMP_WINDOW_MS = 60 * 60 * 1000;

function parseArgs(argv) {
  const passthrough = [];
  for (const flag of ["--days", "--keep"]) {
    const i = argv.indexOf(flag);
    if (i !== -1 && argv[i + 1] !== undefined) passthrough.push(flag, argv[i + 1]);
  }
  const dryRun = argv.includes("--dry-run");
  return {
    force: argv.includes("--force") || dryRun,
    dryRun,
    quiet: argv.includes("--quiet"),
    passthrough,
  };
}

/** Milliseconds since this tree was last swept, or Infinity when it never has been. */
function sinceLastSweep() {
  try {
    const at = Number(readFileSync(STAMP, "utf8").trim());
    return Number.isFinite(at) ? Date.now() - at : Infinity;
  } catch {
    return Infinity; // no stamp — never swept, which is the case this whole item is about
  }
}

function stamp() {
  try {
    mkdirSync(dirname(STAMP), { recursive: true });
    writeFileSync(STAMP, String(Date.now()));
  } catch {
    // no target/ yet, or read-only — the only cost is sweeping again next time
  }
}

/** Run one janitor, returning its output. A janitor that throws is reported and skipped: the point
 *  of the entry point is that one broken sweep cannot take the other down, nor the caller. */
function runJanitor(script, args, quiet) {
  try {
    return execFileSync(process.execPath, [join(REPO_ROOT, "scripts", script), ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (e) {
    if (!quiet) console.warn(`[gc] ${script} skipped: ${(e?.message ?? e).toString().split("\n")[0]}`);
    return "";
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const since = sinceLastSweep();
  if (!opts.force && since < STAMP_WINDOW_MS) {
    if (!opts.quiet) {
      console.log(`[gc] swept ${Math.round(since / 3600000)}h ago — skipping (use --force to sweep now)`);
    }
    return;
  }

  const shared = [...opts.passthrough, ...(opts.dryRun ? ["--dry-run"] : [])];
  const out = [
    runJanitor("prune-incremental.mjs", shared, opts.quiet),
    runJanitor("sweep-target.mjs", shared, opts.quiet),
  ]
    .join("")
    .trim();

  if (!opts.dryRun) stamp();

  // Each janitor already prints its own measured line; relay them rather than inventing a total,
  // because a summed "GB reclaimed" across two different units would be a number nobody can check.
  if (out) console.log(out);
  else if (!opts.quiet) console.log("[gc] nothing to reclaim");
}

try {
  main();
} catch (e) {
  console.warn(`[gc] skipped: ${e?.message ?? e}`);
}
