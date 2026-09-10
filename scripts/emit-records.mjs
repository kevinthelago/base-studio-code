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
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { candidatePaths, pickUsable } from "./lib/bscBinary.mjs";
import { resolveStorePath } from "./lib/recordStore.mjs";

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
/** Is `p` older than the committed store it compiles FROM?
 *
 *  `bsc-emit` is itself a graph-materialized crate: its own source is records, and it reads the store at
 *  run time. So a binary built before the store last moved can be BOTH present and wrong — and its
 *  wrongness is silent, because it emits a smaller, older tree rather than failing.
 *
 *  MEASURED, and it cost most of a day: the dedicated `.promote-gate` worktree held a `bsc-emit` from
 *  two days earlier. Every promote materialized 1,604 seed-derived modules where the store holds 1,609,
 *  so the frontend suite ran 874 files instead of 876 and the kit drift guard failed on three runtime
 *  modules — while the identical commit passed in every tree a human had touched. The gate was not
 *  flaky; it was compiling a different tree. */
function staleAgainstStore(p) {
  try {
    const store = resolveStorePath(REPO);
    if (!existsSync(store)) return false;
    return statSync(store).mtimeMs > statSync(p).mtimeMs;
  } catch {
    return false; // never let a staleness CHECK be the thing that breaks the emit
  }
}

export function emitBinary() {
  if (cached) return cached;
  for (const profile of ["debug", "release"]) {
    const p = join(REPO, "target", profile, EXE);
    // PRESENT IS NOT ENOUGH. Fall through to the build when the store has moved since this binary was
    // made; cargo then decides whether anything actually needs recompiling, which on a current tree is
    // a no-op and on a stale one is the difference between the right tree and a quietly older one.
    if (existsSync(p) && !staleAgainstStore(p)) return (cached = p);
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

/** Materialize the COMPONENT pillar's derived seed files from `graph/components.db`.
 *
 *  `react-ui.json` and its hash sidecar are GENERATED — 5.4 MB whose home is the store — and they are
 *  git-ignored (`the-kit-artifact-is-derived-not-committed`), so a fresh clone or `git worktree add`
 *  has neither. `tsc`, `vitest`, `vite build` and the tauri bundle all read them off disk, which is why
 *  this belongs HERE rather than in the gate alone: `npm run typecheck` and `npm test` both call this
 *  script and neither goes through the gate.
 *
 *  Writes only what differs, so confirming the tree is already correct moves no mtimes — the thing
 *  cargo and vite decide to rebuild on.
 *
 *  A MISSING OR UNUSABLE `bsc` SKIPS IT rather than failing. This script's own job is the record tree;
 *  a checkout that cannot build `bsc` yet still has whatever the last materialization left, and taking
 *  `npm run typecheck` down over a cache would be the worse trade. */
function materializeComponentSeeds() {
  const bsc = pickUsable(candidatePaths(REPO, homedir(), join), {
    statSize: (p) => {
      try {
        return statSync(p).size;
      } catch {
        return null;
      }
    },
    run: (p) => {
      try {
        return { status: 0, stdout: execFileSync(p, ["version"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }) };
      } catch (err) {
        return { status: err.status ?? 1, stdout: String(err.stdout ?? "") };
      }
    },
  });
  if (!bsc) return 0;
  const r = spawnSync(bsc.path, ["ui", "store", "import", "--apply", "--root", REPO], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`bsc ui store import failed: ${(r.stderr || r.stdout || "").trim()}`);
  return Number(/"seeds":\s*(\d+)/.exec(r.stdout ?? "")?.[1] ?? 0);
}

// Still a CLI: `tsc` does not run through vite, so `npm run typecheck` needs a way to materialize the
// tree before type resolution.
if (process.argv[1] && process.argv[1].endsWith("emit-records.mjs")) {
  const r = spawnSync(emitBinary(), ["--repo", REPO], { encoding: "utf8", stdio: "inherit" });
  if ((r.status ?? 1) !== 0) process.exit(r.status ?? 1);
  const n = materializeComponentSeeds();
  if (n) process.stdout.write(`emit-records: materialized ${n} component seed file(s) from the store\n`);
  process.exit(0);
}
