/**
 * Which gate does THIS change need? (#the-gate-runs-everything-on-every-item-regardless-of-what-changed)
 *
 * The gate runs everything on every item regardless of what changed — `cargo clippy --workspace`,
 * `cargo nextest run --workspace`, `tsc`, `eslint .`, and the full 725-file vitest suite, roughly 4-5
 * minutes warm — while a typical item touches 1-5 files. This module decides what a given change can
 * actually have affected. `scripts/gate.mjs` runs it.
 *
 * PURE ON PURPOSE. Everything here takes the changed-file list and the workspace graph as arguments and
 * returns a plan; nothing reads git, the filesystem, or spawns a process. That is what makes the scope
 * decision unit-testable — and a scope decision nobody can test is exactly the thing that would quietly
 * start covering less than the reader assumes.
 *
 * THE SCOPE IS PRINTED BY THE RUNNER, ALWAYS. This repo's recurring failure is not a gate that fails
 * wrongly, it is a gate that PASSES while seeing less than expected: tsc+lint+vitest green with a live
 * Worker deleted; ten stylesheets orphaned with every gate green; a vitest config change that silently
 * dropped 8 test files and reported all-passing. Narrowing the gate is only safe if the narrowing is
 * visible, and if the unscoped gate still runs before anything lands (CLAUDE.md step 7).
 */

/**
 * The commands a plan runs, in order — `{ label, cmd, args }`.
 *
 * Built here rather than inline in the runner so the ARGUMENTS are testable, which matters for exactly
 * one of them: `cargo nextest run` defaults to FAIL-FAST. Without `--no-fail-fast` the first failing
 * test ends the run, and the gate reports a partial picture — observed on the first full dogfood as
 * "532/2393 tests run", i.e. 1,861 tests never executed while the summary looked like a complete
 * verdict. Same species as everything else this feature guards against: not a wrong answer, a
 * narrower one presented as the whole.
 */
export function gateCommands(plan, base) {
  const c = [];
  if (plan.full) {
    c.push({ label: "typecheck", cmd: "npm", args: ["run", "typecheck"] });
    c.push({ label: "lint", cmd: "npm", args: ["run", "lint"] });
    c.push({ label: "vitest", cmd: "npx", args: ["vitest", "run"] });
    c.push({ label: "clippy", cmd: "cargo", args: ["clippy", "--workspace", "--all-targets", "--", "-D", "warnings"] });
    c.push({ label: "nextest", cmd: "cargo", args: ["nextest", "run", "--workspace", "--no-fail-fast"] });
    c.push(...graphCommands());
    return c;
  }
  if (plan.runTsc) c.push({ label: "typecheck (whole-program — never scoped)", cmd: "npm", args: ["run", "typecheck"] });
  if (plan.frontendFiles.length) {
    c.push({ label: "lint (changed files)", cmd: "npx", args: ["eslint", ...plan.frontendFiles] });
  }
  if (plan.runVitest) {
    // A record-store change runs the suite UNSCOPED: `--changed` walks the module graph, and there is no
    // edge from a JSON blob to the modules `emit:records` materializes out of it. Scoping there would
    // report a green gate over tests it never selected.
    c.push(plan.vitestUnscoped
      ? { label: "vitest (unscoped — a record store changed)", cmd: "npx", args: ["vitest", "run"] }
      : { label: "vitest (--changed: module-graph affected)", cmd: "npx", args: ["vitest", "run", "--changed", base] });
  }
  if (plan.rustCrates.length) {
    const p = plan.rustCrates.flatMap((x) => ["-p", x]);
    c.push({ label: "clippy (scoped)", cmd: "cargo", args: ["clippy", ...p, "--all-targets", "--", "-D", "warnings"] });
    c.push({ label: "nextest (scoped)", cmd: "cargo", args: ["nextest", "run", ...p, "--no-fail-fast"] });
  }
  if (plan.runGraph) c.push(...graphCommands());
  return c;
}

/**
 * The GRAPH step — the check the gate has never had.
 *
 * Three commands, and each answers a question the others cannot:
 *
 *  * the SWEEP compiles every Tier-R Rust node from its own `composes` closure. A node that stops
 *    compiling is a red gate, which is the whole point: `unquote.rs` shipped a unicode escape inside a
 *    byte literal precisely because nothing ever compiled these.
 *  * `promote --check` catches a record edited in the runtime store but never promoted into the
 *    committed one the build reads. It is a NO-OP on any machine that did not author the record, which
 *    is what lets it run in CI and in every worktree rather than only on one desk.
 *  * the CROSS-KIT check runs both language kits against one shared vector. Compiling proves a node is
 *    valid Rust; it says nothing about whether `quick-sort.rs` and `quick-sort.ts` compute the same
 *    thing. They are joined only by a NAME, which is the weakest link this library has — and measured,
 *    the two quicksorts really are different algorithms (functional vs in-place Lomuto), so only an
 *    output-level contract can hold them together.
 *
 * The sweep is hash-cached on (materialized source × rustc version), so an unchanged run costs ~0.7s
 * against ~2.7s. It stamps only a GREEN result — caching a failure would hide it on the next run.
 *
 * NOT included: Tier-A byte-attestation (a record's `code` against the file at its `src`). It is filed
 * and deliberately deferred — 28 of the 43 Rust records carrying a `src` have already drifted from
 * their file, so wiring it now would redden the gate on day one for records that are INVENTORY rather
 * than build inputs. Attestation becomes meaningful when a record actually backs a compiled file, which
 * is `crates-materialize-their-source-at-build-time`.
 */
export function graphCommands() {
  return [
    { label: "graph (rust nodes compile)", cmd: "node", args: ["scripts/graph-rust-compile.mjs"] },
    { label: "graph (repo store is current)", cmd: "node", args: ["scripts/graph-promote-check.mjs"] },
    { label: "graph (the kits agree)", cmd: "node", args: ["scripts/graph-cross-kit.mjs"] },
  ];
}

/**
 * Paths that invalidate the scope computation itself, so any change touching one forces the FULL gate.
 *
 * Not a conservatism reflex — each of these can change the result for files it does not contain. A
 * workspace `Cargo.toml` edits the profile every crate compiles under (measured: a profile change makes
 * even a recycled worktree rebuild from scratch, 2m21s). `vitest.config.ts` decides which files are
 * even DISCOVERED — the 8 dropped test files came from exactly that. `tsconfig.json` moves what the
 * whole-program check includes.
 */
export const FORCE_FULL = [
  "Cargo.toml", // the WORKSPACE manifest — profiles + members; a crate's own Cargo.toml is scoped normally
  ".cargo/config.toml",
  "vitest.config.ts",
  "vitest.excludes.ts",
  "eslint.config.js",
  "tsconfig.json",
  "package.json",
  "rust-toolchain.toml",
];

/**
 * Paths out of `git status --porcelain`.
 *
 * Lives here, tested, because getting it subtly wrong is SILENT AND UNDERCOVERS. The first version
 * called `.trim()` on the whole multi-line output and then `slice(3)` per line — which works for every
 * line except the first, whose leading status space `.trim()` had already eaten: ` M package.json`
 * became `M package.json`, and `slice(3)` returned `ackage.json`. That name matched nothing in
 * [`FORCE_FULL`], so a change to `package.json` — which MUST force the full gate — quietly ran as a
 * scoped one. Caught by running this script on its own diff; it would never have announced itself.
 *
 * So: never trim the block, take the path from column 3 onward, and handle rename arrows (`R  a -> b`)
 * by keeping the destination.
 */
export function parsePorcelain(output) {
  const files = [];
  for (const line of output.split("\n")) {
    const l = line.replace(/[\r\n]+$/, "");
    if (l.length < 4) continue;
    let path = l.slice(3);
    const arrow = path.indexOf(" -> ");
    if (arrow >= 0) path = path.slice(arrow + 4); // a rename: the destination is what changed
    path = path.trim();
    if (!path || path.startsWith('"')) continue; // quoted == a path needing unescaping; skip rather than mangle
    files.push(path);
  }
  return files;
}

/** Is `file` a frontend source the gate's TS/lint/vitest half cares about? */
export function isFrontendPath(file) {
  return file.startsWith("src/") || file.startsWith("scripts/") || file.startsWith("vite/")
    || isRecordStorePath(file);
}

/**
 * The RECORD STORES — frontend source that lives under `src-tauri/data/` (#3604, "the graph IS the app").
 *
 * ~1,050 modules ship as records rather than files: ~447 components under `data/components/app/**` and
 * ~676 implementations inside `data/knowledge/algorithms.json`. `npm run emit:records` materializes them
 * into `.bsc-records/` for tsc, vite and vitest, so editing one edits frontend source — it just does not
 * look like it from the path.
 *
 * WITHOUT THIS the scope split (by path: `src-tauri/**` is Rust) classified the single file carrying the
 * most frontend source in the repo as backend. MEASURED on a change that rewrote `personaBridge`: the
 * gate printed `frontend files: 0` and ran neither typecheck, lint nor vitest, then reported PASS. That
 * is this repo's signature failure — a gate that covers less than the reader assumes — and the summary
 * line made it worse, because `0` reads as "no frontend change" rather than "I could not see it".
 *
 * These paths stay RUST too (`crateForPath` still claims `src-tauri/**`), which is correct rather than a
 * compromise: `algorithms.json` is a bundle resource and `src-tauri/src/tests.rs` asserts things about
 * the seeds, so both sides genuinely depend on it.
 */
export function isRecordStorePath(file) {
  return file.startsWith("src-tauri/data/components/")
    || file.startsWith("src-tauri/data/knowledge/");
}

/**
 * Files that can change what the GRAPH step would decide — the two committed stores it sweeps, plus the
 * sweep and the convention it shares with `crates/bsc-graph`.
 *
 * Kept SEPARATE from `isRecordStorePath` even though the knowledge seed appears in both: they answer
 * different questions. That one asks "can vitest still scope itself?", this one asks "could a Rust node
 * have stopped compiling?" — and a change to `graph/algorithms.json`, which is not a frontend record
 * store at all, has to reach the second without touching the first.
 */
export function isGraphSourcePath(file) {
  return file.startsWith("graph/")
    || file.startsWith("src-tauri/data/knowledge/")
    || file.startsWith("crates/bsc-graph/")
    || file === "scripts/graph-rust-compile.mjs"
    || file === "scripts/graph-cross-kit.mjs"
    // The cross-kit CONTRACT: adding a case must re-run the agreement check that reads it.
    || file === "src/features/algorithms/lib/crossKit.fixtures.json";
}

/**
 * The workspace crate owning `file`, or null.
 *
 * Directory name is NOT the package name in this workspace — `crates/data` is `bsc-data`, `crates/llm`
 * is `bsc-llm` — so the caller passes `dirToCrate`, built from `cargo metadata`'s manifest paths rather
 * than guessed from the path.
 */
export function crateForPath(file, dirToCrate) {
  if (file.startsWith("src-tauri/")) return "base-studio-code";
  const m = /^crates\/([^/]+)\//.exec(file);
  if (!m) return null;
  return dirToCrate.get(m[1]) ?? null;
}

/**
 * Every crate that must be checked given `changed` — the changed crates plus everything that depends on
 * them, transitively.
 *
 * `graph` is `Map<crate, string[] deps>`, workspace members only. Measured spread, which is the honest
 * shape of this feature: `bsc-util` reaches 35 of 40 crates, `bsc-graph` 6, `bsc-ui` 1,
 * `base-studio-code` 0. Touching a shared util legitimately means running nearly everything — that is
 * the scope being RIGHT, not the tool underperforming.
 */
export function withDependents(changed, graph) {
  const out = new Set(changed);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, deps] of graph) {
      if (out.has(name)) continue;
      if (deps.some((d) => out.has(d))) {
        out.add(name);
        grew = true;
      }
    }
  }
  return [...out].sort();
}

/**
 * Does this plan need one of the cross-worktree gate slots?
 *
 * THE SLOT FOLLOWS THE COST, NOT THE TIER — and those two came apart. Slots were taken on `full` alone,
 * on the reasoning recorded in `gate.mjs`: a scoped gate "compiles one crate plus its dependents", so
 * queueing for it would trade a real cost against a risk it does not pose. That argument is about CARGO,
 * and cargo is not what dominates a gate's memory.
 *
 * VITEST IS. MEASURED on the live box over 60s of ordinary fleet work: an 18.19 GB peak, of which vitest
 * was 11.45 GB — 8.59 GB across 28 worker processes plus 2.86 GB across SIX concurrent runners — more
 * than the entire Rust toolchain, the app and every agent session combined. None of those six held a
 * slot, because none of them called itself `--full`.
 *
 * They were not small, either. A change to a record store sets `vitestUnscoped`, because `--changed`
 * walks the module graph and cannot see from a JSON store to the modules `emit:records` materializes out
 * of it — so the suite runs WHOLE. That is the right call and stays. The mistake was letting a plan
 * describe itself as scoped while running the full 768-file suite, and inheriting the exemption meant for
 * a cheap one. Most of this frontend IS records (~1,005 modules), so that is not a corner case; it is the
 * common path.
 *
 * Pure and exported so the rule is pinned by a unit test rather than living inside the runner, where the
 * next scope exemption could quietly reopen it.
 */
export function needsGateSlot(plan) {
  return Boolean(plan?.full || (plan?.runVitest && plan?.vitestUnscoped));
}

/**
 * The gate plan for one change.
 *
 * Returns `{ full, reason, rustCrates, frontendFiles, runVitest, runTsc }`. `full` means run the
 * documented unscoped gate — either because something in FORCE_FULL moved, or because the caller asked.
 *
 * `runTsc` is true whenever ANY frontend file changed and is never scoped: `tsc --noEmit` is a
 * whole-program check, so "only the changed files" is not a thing it can do, and at 18.7s measured it is
 * cheap enough to always pay.
 *
 * @param {{ files: string[], graph: Map<string, string[]>, dirToCrate: Map<string, string>,
 *           force?: boolean, exists?: (file: string) => boolean }} input
 */
export function planGate({ files, graph, dirToCrate, force = false, exists = () => true }) {
  if (force) {
    return { full: true, reason: "--full requested", rustCrates: [], frontendFiles: [], runVitest: true, runTsc: true };
  }
  const trigger = files.find((f) => FORCE_FULL.includes(f));
  if (trigger) {
    return {
      full: true,
      reason: `${trigger} changed — it can change the result for files it does not contain`,
      rustCrates: [],
      frontendFiles: [],
      runVitest: true,
      runTsc: true,
    };
  }
  if (files.length === 0) {
    return { full: false, reason: "no changes against the base", rustCrates: [], frontendFiles: [], runVitest: false, runTsc: false };
  }

  const touched = new Set();
  for (const f of files) {
    const c = crateForPath(f, dirToCrate);
    if (c) touched.add(c);
  }
  // A DELETED file is a change, but it is not something eslint can be pointed at: it exits non-zero
  // with `No files matching the pattern "…" were found` and takes the whole lint step with it. Every
  // retirement tranche deletes files, so without this the scoped gate is guaranteed to fail on exactly
  // the work this repo does most (10 deletions in one tranche; 15 in the one before it). `exists` is
  // injected rather than read here so `planGate` stays pure and unit-testable — the runner supplies
  // `existsSync`.
  //
  // ONLY THE ESLINT ARGUMENT LIST IS NARROWED. `runTsc`/`runVitest` key on the CHANGED frontend files,
  // deletions included, because a retired module's importers are exactly what those two catch — deriving
  // them from the filtered list instead made a deletion-only change skip both, which is this repo's
  // signature failure (a gate that covers less and still reports green). The unit test pins it.
  const touchedFrontend = files.filter(isFrontendPath);
  // eslint takes FILES, and a record store is a JSON blob holding many modules — pointing eslint at it
  // lints the JSON, not the TypeScript inside. Excluded from the lint argument list for the same reason
  // deletions are, while still counting for tsc/vitest below.
  const frontendFiles = touchedFrontend.filter((f) => exists(f) && !isRecordStorePath(f));
  // `vitest --changed` walks the MODULE GRAPH, which cannot see from a JSON record store to the modules
  // `emit:records` materializes out of it — the same blind spot that lets a `*.gen.test.ts` reading from
  // disk go unnoticed. So a record-store change runs the suite UNSCOPED rather than pretending the diff
  // told us which tests are affected.
  const touchedRecordStore = files.some(isRecordStorePath);

  return {
    full: false,
    reason: "scoped to what this change can affect",
    rustCrates: touched.size ? withDependents(touched, graph) : [],
    frontendFiles,
    runVitest: touchedFrontend.length > 0,
    runTsc: touchedFrontend.length > 0,
    vitestUnscoped: touchedRecordStore,
    runGraph: files.some(isGraphSourcePath),
  };
}
