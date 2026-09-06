// Materialize retired modules from their packaged seeds into a generated, git-ignored tree.
//
// THE LOGIC LIVES IN RUST NOW — `crates/bsc-emit`, reached by `bsc ui emit records` for an agent and
// by the `bsc-emit` binary for the build tree. This file is what remains: a ~60-line ADAPTER, so the
// seven npm entries, the vite plugin and the gate guards keep their existing call sites while the 502
// lines of decision logic they used to reach are gone.
//
// WHY THE PORT (`emit-records-moves-to-rust-and-collapses-the-last-two-implementations`). This script
// was the ONLY operational consumer of `scripts/lib/recordSource.mjs`, which is a second
// implementation of `crates/bsc-record/src/record_source.rs` — the module's own header argues that a
// census grading differently from the tool that acts is worse than either being wrong alone. It is
// also the thing blocking the fifth acceptance criterion of
// `record-operations-belong-on-the-bsc-surface-not-in-scripts`.
//
// WHY A LEAN BINARY AND NOT `bsc`. This runs from `dev`, `build`, `typecheck`, `test`, `test:watch`,
// `test:coverage` and `emit:records`, and on CI. `bsc` links `bsc-data`, i.e. bundled DuckDB —
// 291 dependency crates, and CLAUDE.md measures a first `cargo build -p bsc --bin bsc` at 343s.
// `bsc-emit` is 12 crates and MEASURED at 6.22s for a true cold build with sccache off. Paying 343s on
// every frontend PR to run a file-copying step is not defensible; 6s is.
//
// PARITY: proved by emitting the whole tree with each implementation and diffing — 1,410 files,
// byte-for-byte identical, plus a whole-value comparison of all seven plan buckets (845 modules,
// 551 tests, 1 shadowed, 4 unresolvable, 13 edge tests).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXE = process.platform === "win32" ? "bsc-emit.exe" : "bsc-emit";

/** Resolved once per process — the plugin polls every 2s and must not re-probe the filesystem for it. */
let cached = null;

/**
 * The `bsc-emit` binary, built if this checkout has not built it yet.
 *
 * NOT A STAGED SIDECAR, deliberately. The staged set derives from `tauri.conf.json`'s
 * `bundle.externalBin` (see `scripts/lib/sidecarBins.mjs`), and putting this there would SHIP a
 * build-tree tool in the installer. It is not something the app runs.
 *
 * MOST-LOCAL FIRST, then build. `debug` before `release` because a local build is what you are
 * iterating on. The one-time `cargo build` keeps the zero-install nested-worktree flow working: a
 * fresh worktree still needs no `npm install`, and pays 6s of cargo once instead.
 */
export function emitBinary() {
  if (cached) return cached;
  for (const profile of ["debug", "release"]) {
    const p = join(REPO, "target", profile, EXE);
    if (existsSync(p)) return (cached = p);
  }
  // `--quiet` so a routine `npm run typecheck` does not open with cargo's progress bar; failures still
  // reach stderr, and a build that cannot happen must be LOUD — unlike the gc, a missing emit leaves
  // tsc and vitest resolving against a tree that is absent or stale, which is a wrong answer, not a
  // skipped chore.
  execFileSync("cargo", ["build", "--quiet", "-p", "bsc-emit", "--bin", "bsc-emit"], {
    cwd: REPO,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const built = join(REPO, "target", "debug", EXE);
  if (!existsSync(built)) throw new Error(`cargo build produced no ${EXE}`);
  return (cached = built);
}

/** Reconcile `.bsc-records/` to the seeds.
 *
 *  RETURNS `{materialized, changed, pruned}` — an object, where the JavaScript implementation returned
 *  the specifier ARRAY with those counts hung off it. Checked before changing it: the only live caller
 *  is `vite/bscRecords.ts`, which discards the value entirely, and the one test that read `.changed`
 *  and `.pruned` is deleted with this change (its assertions moved to `crates/bsc-emit/src/emit.rs`).
 *  Carrying an array nobody reads, purely to preserve a shape, would be worse than saying so. */
export function emitRecords({ quiet = false } = {}) {
  // ONE spawn, not two: `--json` and the human report are the same run, and asking twice would emit
  // twice — the second one reconciling against the tree the first just wrote, so it would always
  // report `0 written` and hide what actually moved.
  const args = quiet ? ["--repo", REPO, "--json"] : ["--repo", REPO];
  const r = spawnSync(emitBinary(), args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`bsc-emit failed: ${(r.stderr || r.stdout || "").trim()}`);
  if (!quiet) {
    process.stdout.write(r.stdout ?? "");
    return { materialized: null, changed: null, pruned: null };
  }
  const out = JSON.parse(r.stdout);
  return { materialized: out.materialized, changed: out.written, pruned: out.pruned };
}

/** DECIDE what would be emitted, writing nothing.
 *
 *  Split from the writing half so a guard can ask "would this record's test actually run?" without
 *  triggering an emit — an emit PRUNES, and a prune mid-suite would delete files out from under every
 *  other file being collected in parallel. */
export function planRecords() {
  const r = spawnSync(emitBinary(), ["--repo", REPO, "--plan", "--json"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`bsc-emit --plan failed: ${(r.stderr || r.stdout || "").trim()}`);
  return JSON.parse(r.stdout);
}

// Still a CLI: `tsc` does not run through vite, so `npm run typecheck` needs a way to materialize the
// tree before type resolution.
if (process.argv[1] && process.argv[1].endsWith("emit-records.mjs")) {
  const r = spawnSync(emitBinary(), ["--repo", REPO], { encoding: "utf8", stdio: "inherit" });
  process.exit(r.status ?? 1);
}
