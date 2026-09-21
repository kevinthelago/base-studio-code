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
/// Each leg carries a stable `key` and a `stage` alongside its human `label`, and the two are separate
/// on purpose. The LABEL is prose and moves ("vitest" vs "vitest (--changed: module-graph affected)");
/// the KEY is what a recorded measurement is filed under, so a scoped run and a full run of the same
/// leg land in ONE history rather than two that can never be compared. `stage` maps the leg onto the
/// existing fault taxonomy rather than inventing a "gate" stage for it.
export function gateCommands(plan, base) {
  const c = [];
  // A RECORD MUST NOT CLAIM A MODULE IT IS NOT — and this leg is UNCONDITIONAL, in both tiers, which
  // is the whole point of it.
  //
  // Every other leg is scoped by what THIS branch changed. That is exactly wrong here, because the
  // drift this catches is not caused by a changed file: `detachedwindow` was re-claimed by a designer
  // session writing to ~/.base-studio-code/components.db, touching nothing in the repo. It stubbed
  // `@/store`, `TerminalHost` and the `lazyWorkspaces` barrel to make the preview build (rev 10), then
  // republished the specifier "so App and other composers can import" it (rev 12) — re-breaking what
  // revs 3 and 7 had each already fixed. No changed-file scope would ever have selected it, and there
  // is no record of it in the packaged seed to diff against, so a seed-only check is blind too.
  // docs/records.md names this as the case no gate observes.
  //
  // `bsc components census` is REUSED rather than reimplemented: it already classifies WHY a pair disagrees
  // (`preview-derivative` vs `newer-truth`), already reads the runtime stores, and already honours a
  // record's `srcDivergence` note, so an adjudicated multi-component module like `ui-charts` is not
  // reported as drift. A hand-rolled path-matching script gets all three wrong — mine did, and called
  // four divergences where there are two. It exits non-zero on disagreement, so it gates as-is.
  //
  // Affordable unconditionally: MEASURED 0.15-0.18s and ~90 MB, cheaper than deciding whether to run it.
  c.push({ label: "records (no record claims a module it is not)", key: "graph-claim-census", stage: "test", cmd: "bsc", args: ["components", "census"] });
  if (plan.full) {
    c.push({ label: "typecheck", key: "typecheck", stage: "typecheck", cmd: "npm", args: ["run", "typecheck"] });
    c.push({ label: "lint", key: "lint", stage: "lint", cmd: "npm", args: ["run", "lint"] });
    c.push({ label: "vitest", key: "vitest", stage: "test", cmd: "npx", args: ["vitest", "run"] });
    c.push({ label: "clippy", key: "clippy", stage: "lint", cmd: "cargo", args: ["clippy", "--workspace", "--all-targets", "--", "-D", "warnings"] });
    c.push({ label: "nextest", key: "nextest", stage: "test", cmd: "cargo", args: ["nextest", "run", "--workspace", "--no-fail-fast"] });
    // DOCTESTS, which `nextest` structurally does not run. They were guarded by a static scan for
    // untagged ``` fences, and that scan could not see an INDENTED code block — which rustdoc compiles
    // as Rust just the same, and which cannot be tagged because there is nowhere to write `text` on it.
    // Three doctests were failing on develop behind a green gate. Running the real thing needs no
    // heuristic and cannot report a private item that could never have run: MEASURED at 7.53s warm for
    // the whole workspace, cheaper than clippy.
    c.push({ label: "doctest", key: "doctest", stage: "test", cmd: "cargo", args: ["test", "--workspace", "--doc"] });
    c.push(...graphCommands());
    return c;
  }
  if (plan.runTsc) c.push({ label: "typecheck (whole-program — never scoped)", key: "typecheck", stage: "typecheck", cmd: "npm", args: ["run", "typecheck"] });
  if (plan.frontendFiles.length) {
    c.push({ label: "lint (changed files)", key: "lint", stage: "lint", cmd: "npx", args: ["eslint", ...plan.frontendFiles] });
  }
  if (plan.runVitest) {
    // A record-store change runs the suite UNSCOPED: `--changed` walks the module graph, and there is no
    // edge from a JSON blob to the modules `emit:records` materializes out of it. Scoping there would
    // report a green gate over tests it never selected.
    c.push(plan.vitestUnscoped
      ? { label: "vitest (unscoped)", key: "vitest", stage: "test", cmd: "npx", args: ["vitest", "run"] }
      : { label: "vitest (--changed: module-graph affected)", key: "vitest", stage: "test", cmd: "npx", args: ["vitest", "run", "--changed", base] });
  }
  if (plan.rustCrates.length) {
    const p = plan.rustCrates.flatMap((x) => ["-p", x]);
    c.push({ label: "clippy (scoped)", key: "clippy", stage: "lint", cmd: "cargo", args: ["clippy", ...p, "--all-targets", "--", "-D", "warnings"] });
    c.push({ label: "nextest (scoped)", key: "nextest", stage: "test", cmd: "cargo", args: ["nextest", "run", ...p, "--no-fail-fast"] });
    c.push({ label: "doctest (scoped)", key: "doctest", stage: "test", cmd: "cargo", args: ["test", ...p, "--doc"] });
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
    { label: "graph (rust nodes compile)", key: "graph-rust-compile", stage: "compile", cmd: "node", args: ["scripts/graph-rust-compile.mjs"] },
    { label: "graph (repo store is current)", key: "graph-promote-check", stage: "compile", cmd: "node", args: ["scripts/graph-promote-check.mjs"] },
    { label: "graph (the kits agree)", key: "graph-cross-kit", stage: "test", cmd: "node", args: ["scripts/graph-cross-kit.mjs"] },
    // The Rust EDGE tier's two-copy invariant (`a-rust-record-test-runs-and-an-edge-reaches-the-seed`).
    // A carried Rust test is a real cargo test target now, so it CAN silently stop running: delete the
    // file, forget the `[[test]]` entry, and nextest reports all-passing with 8 fewer tests in it
    // (measured, 67 -> 59). This is the only thing that looks. It also catches the record and the file
    // it was lifted from drifting apart, which it found on its FIRST run.
    { label: "graph (rust test edges)", key: "graph-rust-tests", stage: "test", cmd: "node", args: ["scripts/graph-rust-tests.mjs"] },
    // Every import/use of another record IS a relationship (`bsc-graph-derives-and-verifies-relationships`);
    // this fails when a NEW/edited record uses a record without a `composes` edge, vs a grandfathered baseline.
    { label: "graph (relationships)", key: "graph-relationships", stage: "test", cmd: "node", args: ["scripts/graph-relationships.mjs", "--check"] },
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
  // `.config/nextest.toml` decides how EVERY Rust test in the workspace is run, so a change to it can
  // change the verdict for tests in crates the diff never touches. It now carries
  // `slow-timeout = { period = "60s", terminate-after = 2 }`, which is exactly that kind of setting:
  // it converts a test that merely runs long into a test that gets KILLED. MEASURED 2026-09-12, the
  // six `atlasdb` tests took 139s each inside a full `--workspace` run while PASSING — under that cap
  // they would instead have been terminated. So editing this file while running only the scoped gate
  // could land a change that reddens crates the scope never compiled, which is this repo's signature
  // failure: a gate that passes while covering less than the reader assumes.
  ".config/nextest.toml",
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
 * The RECORD STORES — frontend source that does not live under `src/` (#3604, "the graph IS the app").
 *
 * ~1,050 modules ship as records rather than files: the components under `data/components/app/**`, and
 * the implementations in the COMMITTED store, the ledger database `graph/store.toml` names.
 * `npm run emit:records` materializes them into `.bsc-records/` for tsc, vite and vitest, so editing one
 * edits frontend source — it just does not look like it from the path.
 *
 * WITHOUT THIS the scope split (by path: `src-tauri/**` is Rust, `graph/**` is the graph step) classified
 * the files carrying the most frontend source in the repo as backend. MEASURED on a change that rewrote
 * `personaBridge`: the gate printed `frontend files: 0` and ran neither typecheck, lint nor vitest, then
 * reported PASS. That is this repo's signature failure — a gate that covers less than the reader assumes
 * — and the summary line made it worse, because `0` reads as "no frontend change" rather than "I could
 * not see it".
 *
 * THE COMMITTED STORE JOINED THIS LIST when `retire-the-packaged-seed-directories` re-pointed
 * `bsc-emit` off the packaged algorithms seed and onto it. Before that, `graph/**` was claimed only by
 * `isGraphSourcePath` — a question about Rust — so the moment the emitter started reading it, editing
 * the record holding a frontend module would have run neither tsc nor vitest. The same bug, one
 * directory over.
 *
 * THE PER-RECORD NARROWING IS GONE, and it is worth being explicit about rather than discovering.
 * While records were one file each, this claimed only the ~658 carrying an `@/` provides and left the
 * ~1,944 Rust ones to the graph arms — worth ~128s and an 11 GB gate slot on every Rust record edit.
 * A database is ONE PATH holding both populations, and a path predicate cannot see inside it, so every
 * record edit now runs the unscoped frontend suite. That is a real cost the ledger imposes and it is
 * tracked as such (`the-committed-store-is-a-database`); the alternative — not claiming the store —
 * is the far worse one, because editing the record that HOLDS a frontend module would run no frontend
 * arm at all and report PASS.
 *
 * These paths stay RUST/graph too, which is correct rather than a compromise: `graph-materialize`
 * compiles 25 crates from the committed store, `algorithms.json` is a bundle resource, and
 * `src-tauri/src/tests.rs` asserts things about the seeds — both sides genuinely depend on them.
 */
export function isRecordStorePath(file) {
  return file.startsWith("src-tauri/data/components/")
    || file.startsWith("src-tauri/data/knowledge/")
    // THE COMMITTED STORE, in either layout. `graph/store.toml` names it and decides its format, so the
    // database is matched by EXTENSION rather than by filename — a store renamed through the marker
    // must not silently drop out of the frontend arms, which is the whole failure this claim exists for.
    // The marker itself counts: it is what decides which file the build reads at all.
    || /^graph\/[^/]+\.db$/.test(file)
    || file === "graph/store.toml"
    // The pre-database layouts, kept so a checkout on an older store is still classified correctly.
    || file === "graph/algorithms.json"
    || (file.startsWith("graph/records/") && /\.tsx?\.json$/.test(file));
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
  // A crate's OWN manifest decides whether a graph-carried `[[test]]` target is compiled at all, so
  // editing one can stop a test running without touching a line of source.
  if (/^crates\/[^/]+\/Cargo\.toml$/.test(file)) return true;
  return file.startsWith("graph/")
    || file.startsWith("src-tauri/data/knowledge/")
    || file.startsWith("crates/bsc-graph/")
    || file === "scripts/graph-rust-compile.mjs"
    || file === "scripts/graph-cross-kit.mjs"
    || file === "scripts/graph-rust-tests.mjs"
    || file === "scripts/graph-relationships.mjs"
    || file === "scripts/graph-relationships.baseline.json"
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
  // ...AND A DELETION, for a DIFFERENT blind spot that composes with that one. `--changed` selects tests
  // by walking the module graph FROM the changed files, and a deleted file has no edges in the new graph —
  // nothing imports it, because it is gone — so it selects NOTHING. The tests that actually break are the
  // ones that read from DISK rather than importing (`*.gen.test.ts`), which no import walk could have
  // reached anyway.
  //
  // MEASURED: retiring `src/features/skills/index.tsx` passed the scoped gate (60 files, 750 tests) and
  // then failed 4 tests in `reactUiKit.gen.test.ts`, because deleting it changed the packaged kit's
  // closure. That was the FIFTH stale packaged kit in one session and three of them reached `develop`.
  //
  // The record-store rule does not cover this: that change touches `src/` only, so it never fires.
  const deletedFrontend = touchedFrontend.filter((f) => !exists(f));

  // WHICH trigger fired, so the printed scope can say. Two rules reach the same decision for different
  // reasons, and "vitest runs unscoped" without the why is the kind of note a reader learns to skip.
  const unscopedReason = touchedRecordStore
    ? "a record store changed — `--changed` cannot see from a JSON blob to the modules emit:records materializes from it"
    : deletedFrontend.length
      ? `${deletedFrontend.length} frontend file(s) DELETED (${deletedFrontend.slice(0, 3).join(", ")}) — a deleted file has no module-graph edges, so \`--changed\` selects nothing`
      : null;

  return {
    full: false,
    reason: "scoped to what this change can affect",
    rustCrates: touched.size ? withDependents(touched, graph) : [],
    frontendFiles,
    runVitest: touchedFrontend.length > 0,
    runTsc: touchedFrontend.length > 0,
    vitestUnscoped: Boolean(unscopedReason),
    unscopedReason,
    runGraph: files.some(isGraphSourcePath),
  };
}
