// The scope decision for `npm run gate`
// (#the-gate-runs-everything-on-every-item-regardless-of-what-changed).
//
// Worth testing properly rather than eyeballing, because the failure mode is SILENT: a scope that comes
// out too small does not error, it just runs less and reports green. That is the exact shape of every
// gate incident this repo has recorded — tsc+lint+vitest green with a live Worker deleted, ten
// stylesheets orphaned with every gate green, and a vitest config change that dropped 8 test files while
// reporting all-passing.
import { describe, it, expect } from "vitest";
import { planGate, withDependents, crateForPath, isFrontendPath, parsePorcelain, gateCommands, graphCommands, isGraphSourcePath, needsGateSlot, FORCE_FULL } from "./gateScope.mjs";

// A miniature of the real workspace shape: one shared util everything sits on, one mid-tier crate, two
// leaves. The real graph measures bsc-util at 35 of 40 dependents and bsc-ui at 1.
const graph = new Map<string, string[]>([
  ["bsc-util", []],
  ["bsc-graph", ["bsc-util"]],
  ["bsc-ui", ["bsc-graph"]],
  ["bsc", ["bsc-ui", "bsc-graph", "bsc-util"]],
  ["base-studio-code", ["bsc-util"]],
]);
const dirToCrate = new Map<string, string>([
  ["bsc-util", "bsc-util"],
  ["bsc-graph", "bsc-graph"],
  ["bsc-ui", "bsc-ui"],
  ["data", "bsc-data"], // dir name != package name — the case a path-guess would get wrong
]);

const plan = (files: string[], force = false) => planGate({ files, graph, dirToCrate, force });

describe("gate scope", () => {
  it("maps a path to its crate by PACKAGE name, not directory name", () => {
    // `crates/data` is the package `bsc-data`. Guessing from the path would produce a `-p bsc-data`
    // that does not exist for `crates/llm` (`bsc-llm`) either, so the map comes from cargo metadata.
    expect(crateForPath("crates/data/src/lib.rs", dirToCrate)).toBe("bsc-data");
    expect(crateForPath("src-tauri/src/app/run.rs", dirToCrate)).toBe("base-studio-code");
    expect(crateForPath("src/features/x/lib/y.ts", dirToCrate)).toBeNull();
    expect(crateForPath("crates/unknown-crate/src/lib.rs", dirToCrate)).toBeNull();
  });

  it("pulls in every transitive dependent, not just direct ones", () => {
    // bsc-util -> bsc-graph -> bsc-ui is two hops; a direct-dependents-only implementation would stop
    // at bsc-graph and skip bsc-ui's tests entirely.
    expect(withDependents(["bsc-util"], graph)).toEqual([
      "base-studio-code",
      "bsc",
      "bsc-graph",
      "bsc-ui",
      "bsc-util",
    ]);
    expect(withDependents(["bsc-ui"], graph)).toEqual(["bsc", "bsc-ui"]);
  });

  it("scopes a leaf narrowly and a shared util widely — the spread is the point", () => {
    const leaf = plan(["crates/bsc-ui/src/kit.rs"]);
    expect(leaf.full).toBe(false);
    expect(leaf.rustCrates).toEqual(["bsc", "bsc-ui"]);

    // Touching the shared util legitimately reaches nearly everything. Scoping is not "always faster";
    // it is "exactly what could be affected", and here that is almost the whole graph.
    const shared = plan(["crates/bsc-util/src/lib.rs"]);
    expect(shared.rustCrates.length).toBe(graph.size);
  });

  it("forces the FULL gate for files that change the result for files they do not contain", () => {
    for (const f of FORCE_FULL) {
      const p = plan([f]);
      expect(p.full, `${f} must force the full gate`).toBe(true);
      expect(p.reason).toContain(f);
    }
    // The workspace manifest forces full; a CRATE's own manifest is scoped like any other source.
    expect(plan(["crates/bsc-ui/Cargo.toml"]).full).toBe(false);
  });

  it("always runs tsc when frontend files change, and never tries to scope it", () => {
    // `tsc --noEmit` is whole-program — "just the changed files" is not something it can do, and at
    // 18.7s measured it is cheap enough to always pay.
    const p = plan(["src/features/x/lib/y.ts"]);
    expect(p.runTsc).toBe(true);
    expect(p.runVitest).toBe(true);
    expect(p.rustCrates).toEqual([]);

    // A Rust-only change must not drag the frontend half in.
    const rustOnly = plan(["crates/bsc-ui/src/kit.rs"]);
    expect(rustOnly.runTsc).toBe(false);
    expect(rustOnly.runVitest).toBe(false);
  });

  it("classifies frontend paths including scripts/ and vite/, which carry their own tests", () => {
    expect(isFrontendPath("src/app/App.tsx")).toBe(true);
    expect(isFrontendPath("scripts/gate.mjs")).toBe(true);
    expect(isFrontendPath("vite/bscRecords.ts")).toBe(true);
    expect(isFrontendPath("crates/bsc-ui/src/kit.rs")).toBe(false);
    expect(isFrontendPath("docs/backend.md")).toBe(false);
  });


  it("parses porcelain without eating the first line's path — the bug that made a FULL run go SCOPED", () => {
    // `git status --porcelain` encodes status in the first two COLUMNS. The first implementation
    // trimmed the whole block and then sliced(3) per line, which is right for every line except the
    // first — whose leading status space trim() had already removed. ` M package.json` became
    // `M package.json`, sliced to `ackage.json`, matched nothing in FORCE_FULL, and a change to
    // package.json quietly ran as a SCOPED gate instead of the full one it must force.
    const out = [" M package.json", "?? scripts/gate.mjs", "M  src/a.ts", "A  src/b.ts", ""].join("\n");
    expect(parsePorcelain(out)).toEqual(["package.json", "scripts/gate.mjs", "src/a.ts", "src/b.ts"]);

    // ...and end to end: that exact porcelain must force the full gate.
    expect(planGate({ files: parsePorcelain(out), graph, dirToCrate }).full).toBe(true);
  });

  it("keeps the DESTINATION of a rename, and skips quoted paths rather than mangling them", () => {
    expect(parsePorcelain(["R  old/name.ts -> src/new/name.ts", ""].join("\n"))).toEqual([
      "src/new/name.ts",
    ]);
    // A quoted path is git escaping something; skipping beats handing a mangled name to eslint.
    expect(parsePorcelain([' M "src/weird\\303\\257.ts"', ""].join("\n"))).toEqual([]);
    expect(parsePorcelain(["", "   ", ""].join("\n"))).toEqual([]);
  });


  it("always passes --no-fail-fast to nextest, in BOTH tiers", () => {
    // nextest defaults to fail-fast. Without this the first failing test ends the run and the gate
    // reports a partial verdict — observed on the first full dogfood as "532/2393 tests run", with
    // 1,861 tests never executed under a summary that read like a complete answer.
    const full = gateCommands(plan([], true), "develop");
    const nxFull = full.find((c) => c.args.includes("nextest"));
    expect(nxFull?.args).toContain("--no-fail-fast");

    const scoped = gateCommands(plan(["crates/bsc-ui/src/kit.rs"]), "develop");
    const nxScoped = scoped.find((c) => c.args.includes("nextest"));
    expect(nxScoped?.args).toContain("--no-fail-fast");
    expect(nxScoped?.args).toEqual(["nextest", "run", "-p", "bsc", "-p", "bsc-ui", "--no-fail-fast"]);
  });

  it("runs doctests in BOTH tiers — nextest structurally cannot", () => {
    // `cargo nextest` does not run doctests at all. That property used to be defended by a static scan
    // for untagged ``` fences in src-tauri/src/tests.rs, which could not see an INDENTED code block —
    // rustdoc compiles those as Rust just the same, and there is nowhere to write ```text on one. Three
    // doctests were failing on develop behind a green gate, and a naive widening of that scan reported
    // three false positives out of five, because rustdoc never collects a doctest on a private item.
    //
    // So the gate runs the real thing instead of guessing about it: no heuristic, no false positives,
    // and MEASURED at 7.53s warm for the whole workspace — cheaper than clippy. This test is what keeps
    // the leg from quietly disappearing again.
    const full = gateCommands(plan([], true), "develop");
    expect(full.find((c) => c.key === "doctest")?.args).toEqual(["test", "--workspace", "--doc"]);

    const scoped = gateCommands(plan(["crates/bsc-ui/src/kit.rs"]), "develop");
    expect(scoped.find((c) => c.key === "doctest")?.args).toEqual(["test", "-p", "bsc", "-p", "bsc-ui", "--doc"]);
  });

  it("builds the scoped frontend commands against the base", () => {
    const cmds = gateCommands(plan(["src/features/x/lib/y.ts"]), "develop");
    expect(cmds.map((c) => c.label.split(" ")[0])).toEqual(["typecheck", "lint", "vitest"]);
    expect(cmds.find((c) => c.label.startsWith("vitest"))?.args).toEqual([
      "vitest", "run", "--changed", "develop",
    ]);
    // eslint gets the changed files, not the whole tree.
    expect(cmds.find((c) => c.label.startsWith("lint"))?.args).toEqual([
      "eslint", "src/features/x/lib/y.ts",
    ]);
  });

  it("runs nothing when nothing changed, and everything when asked", () => {
    expect(plan([]).runVitest).toBe(false);
    expect(plan([]).rustCrates).toEqual([]);
    expect(plan(["src/x.ts"], true).full).toBe(true);
  });

  it("treats a mixed change as both halves", () => {
    const p = plan(["crates/bsc-graph/src/lib.rs", "src/features/x/lib/y.ts"]);
    expect(p.full).toBe(false);
    expect(p.rustCrates).toEqual(["bsc", "bsc-graph", "bsc-ui"]);
    expect(p.frontendFiles).toEqual(["src/features/x/lib/y.ts"]);
    expect(p.runTsc).toBe(true);
  });

  // A DELETED file is a change, and it is not something eslint can be pointed at: it exits non-zero
  // with `No files matching the pattern "…" were found`, which fails the whole lint step. Every
  // retirement tranche deletes files, so before this the scoped gate was guaranteed to fail on the
  // work this repo does most — a 10-module tranche hit it, and the 15-module one before it would have.
  it("keeps a DELETED file out of the lint list", () => {
    const files = ["src/app/chrome/Titlebar.tsx", "src/features/x/lib/y.ts"];
    const exists = (f: string) => f !== "src/app/chrome/Titlebar.tsx";
    const p = planGate({ files, graph, dirToCrate, exists });
    expect(p.frontendFiles).toEqual(["src/features/x/lib/y.ts"]);
  });

  it("still runs tsc and vitest when the ONLY frontend change is a deletion", () => {
    // The deletion is exactly what tsc and vitest must see — a retired module's importers are what
    // break. Only the eslint ARGUMENT list is narrowed, never the checks themselves.
    const p = planGate({ files: ["src/app/chrome/Titlebar.tsx"], graph, dirToCrate, exists: () => false });
    expect(p.frontendFiles).toEqual([]);
    expect(p.runTsc).toBe(true);
    expect(p.runVitest).toBe(true);
  });

  it("defaults to assuming every file exists, so a caller with no fs behaves as before", () => {
    expect(plan(["src/features/x/lib/y.ts"]).frontendFiles).toEqual(["src/features/x/lib/y.ts"]);
  });
});


// ── a DELETION forces vitest unscoped ────────────────────────────────────────────────────────────
//
// `vitest --changed` selects tests by walking the module graph FROM the changed files. A DELETED file has
// no edges in the new graph — nothing imports it, because it is gone — so it selects NOTHING, and the
// tests that actually break are the ones reading from DISK rather than importing (`*.gen.test.ts`).
//
// MEASURED: retiring `src/features/skills/index.tsx` passed the scoped gate (60 files, 750 tests) and then
// failed 4 tests in `reactUiKit.gen.test.ts`, because the deletion changed the packaged kit's closure.
// Fifth stale packaged kit in one session; three reached `develop`.
describe("a frontend DELETION runs vitest unscoped", () => {
  const planWith = (files: string[], exists: (f: string) => boolean) =>
    planGate({ files, graph, dirToCrate, exists });

  it("forces the unscoped run, and NAMES the deletion as the trigger", () => {
    const p = planWith(["src/features/skills/index.tsx"], () => false);
    expect(p.vitestUnscoped).toBe(true);
    expect(p.unscopedReason).toContain("DELETED");
    expect(p.unscopedReason).toContain("src/features/skills/index.tsx");
    // ...and the plan actually RUNS vitest, so the trigger is not moot.
    expect(p.runVitest).toBe(true);
  });

  it("does NOT abandon the narrowing for an ordinary edit", () => {
    const p = planWith(["src/features/skills/index.tsx"], () => true);
    expect(p.vitestUnscoped).toBe(false);
    expect(p.unscopedReason).toBeNull();
    expect(p.runVitest).toBe(true);
  });

  it("names the RECORD STORE trigger when that is the one that fired", () => {
    // Two rules reach the same decision; the note has to say which, or a reader learns to skip it.
    const p = planWith(["src-tauri/data/components/app/x.json"], () => true);
    expect(p.vitestUnscoped).toBe(true);
    expect(p.unscopedReason).toContain("record store");
    expect(p.unscopedReason).not.toContain("DELETED");
  });

  it("the emitted vitest command really is unscoped — no --changed", () => {
    const cmds = gateCommands(planWith(["src/a/Gone.tsx"], () => false), "HEAD");
    const vitest = cmds.find((c) => c.key === "vitest");
    expect(vitest?.args).toEqual(["vitest", "run"]);
    expect(vitest?.args).not.toContain("--changed");
  });

  it("a deletion makes it a HEAVY gate, so it queues for a slot like --full", () => {
    // The slot follows the COST, not the tier: an unscoped vitest is the expensive half.
    expect(needsGateSlot(planWith(["src/a/Gone.tsx"], () => false))).toBe(true);
    expect(needsGateSlot(planWith(["src/a/Here.tsx"], () => true))).toBe(false);
  });
});

// ── record stores are FRONTEND source, not backend data ──────────────────────────────────────────
//
// ~1,050 modules ship as records under `src-tauri/data/` (#3604). The scope split is by path, and
// `src-tauri/**` means Rust — so the single file carrying the most frontend source in the repo was
// classified as backend. MEASURED on a change that rewrote `personaBridge` (which lives inside
// `data/knowledge/algorithms.json`): the gate printed `frontend files: 0`, ran neither typecheck nor
// lint nor vitest, and reported PASS. It happened three times in one epic before it was diagnosed.
describe("record stores under src-tauri/data are frontend (gate scoping)", () => {
  // Reuse the file's shared fixtures rather than inventing a second pair — the first draft built its
  // own and got the `graph` value type wrong (Set vs string[]), which typecheck caught and the tests
  // did not, since planGate never reads it on these paths.
  const plan = (files: string[]) => planGate({ files, graph, dirToCrate, exists: () => true });

  it("the algorithms seed runs the frontend arms", () => {
    const p = plan(["src-tauri/data/knowledge/algorithms.json"]);
    expect(p.runTsc, "typecheck must run — the seed holds ~676 frontend modules").toBe(true);
    expect(p.runVitest).toBe(true);
  });

  it("the component seeds run them too", () => {
    const p = plan(["src-tauri/data/components/app/features/teams/teams-inspector.json"]);
    expect(p.runTsc).toBe(true);
    expect(p.runVitest).toBe(true);
  });

  it("a record-store change runs vitest UNSCOPED", () => {
    // `--changed` walks the module graph and there is no edge from a JSON blob to what
    // `emit:records` materializes out of it, so scoping would select tests that cannot see the change.
    expect(plan(["src-tauri/data/knowledge/algorithms.json"]).vitestUnscoped).toBe(true);
    expect(plan(["src/store/index.ts"]).vitestUnscoped).toBeFalsy();
  });

  it("a record store is NOT handed to eslint, which would lint the JSON rather than the TS in it", () => {
    expect(plan(["src-tauri/data/knowledge/algorithms.json"]).frontendFiles).toEqual([]);
  });

  it("a record store stays RUST as well — both sides really do depend on it", () => {
    // `algorithms.json` is a bundle resource and `src-tauri/src/tests.rs` asserts things about the
    // seeds, so claiming it for the frontend must not release it from the Rust arms.
    expect(plan(["src-tauri/data/knowledge/algorithms.json"]).rustCrates).toContain("base-studio-code");
  });

  it("ordinary backend data is still backend only", () => {
    const p = plan(["src-tauri/data/permissions/write-locks.json"]);
    expect(p.runTsc).toBe(false);
    expect(p.runVitest).toBe(false);
  });
});

// The GRAPH step — the check the gate has never had (the-graph-gets-a-gate).
//
// Its failure mode is the one this whole module exists to prevent: a Rust node stops compiling, or a
// record is edited and never promoted into the committed store the build reads, and nothing says so.
describe("graph step", () => {
  const plan = (files: string[], force = false) => planGate({ files, graph, dirToCrate, force });

  it("runs when either COMMITTED store moves", () => {
    expect(plan(["graph/algorithms.json"]).runGraph).toBe(true);
    expect(plan(["src-tauri/data/knowledge/algorithms.json"]).runGraph).toBe(true);
  });

  it("runs when the convention itself moves — the sweep or the crate that owns its twin", () => {
    expect(plan(["scripts/graph-rust-compile.mjs"]).runGraph).toBe(true);
    expect(plan(["crates/bsc-graph/src/rust_test.rs"]).runGraph).toBe(true);
  });

  it("does NOT run for a change that cannot affect a node", () => {
    expect(plan(["src/features/planner/lib/x.ts"]).runGraph).toBe(false);
    expect(plan(["crates/plandb/src/lib.rs"]).runGraph).toBe(false);
  });

  it("is always part of the FULL gate, however the change got there", () => {
    const labels = gateCommands(plan([], true), "develop").map((c) => c.label);
    expect(labels.some((l) => l.startsWith("graph ("))).toBe(true);
  });

  it("appears in a scoped gate exactly when the plan asked for it", () => {
    const withGraph = gateCommands(plan(["graph/algorithms.json"]), "develop").map((c) => c.label);
    expect(withGraph.some((l) => l.startsWith("graph ("))).toBe(true);
    const without = gateCommands(plan(["crates/plandb/src/lib.rs"]), "develop").map((c) => c.label);
    expect(without.some((l) => l.startsWith("graph ("))).toBe(false);
  });

  it("carries all three halves — nodes compile, the repo store is current, the kits agree", () => {
    const cmds = graphCommands();
    expect(cmds).toHaveLength(3);
    expect(cmds[0].args).toContain("scripts/graph-rust-compile.mjs");
    expect(cmds[1].args).toContain("scripts/graph-promote-check.mjs");
    expect(cmds[2].args).toContain("scripts/graph-cross-kit.mjs");
  });

  // Adding a case to the contract must re-run the check that reads it, or the vector grows while
  // nothing verifies the new case.
  it("runs when the cross-kit CONTRACT changes", () => {
    expect(plan(["src/features/algorithms/lib/crossKit.fixtures.json"]).runGraph).toBe(true);
  });

  // `graph/` is not a frontend record store, and the knowledge seed is BOTH. The two predicates answer
  // different questions and must not be collapsed.
  it("is a separate question from the record-store predicate", () => {
    expect(isGraphSourcePath("graph/algorithms.json")).toBe(true);
    expect(isFrontendPath("graph/algorithms.json")).toBe(false);
    expect(isGraphSourcePath("src-tauri/data/components/app/x.json")).toBe(false);
  });
});

// ── which gates queue for a fleet slot (#a-scoped-gate-runs-the-whole-vitest-suite-and-takes-no-slot) ──
//
// THE RULE IS ABOUT COST, AND IT USED TO BE ABOUT THE TIER. Slots were taken on `full` alone, which
// exempted every plan that runs vitest UNSCOPED — the whole 768-file suite — because such a plan still
// describes itself as scoped. MEASURED on the live box during ordinary fleet work: an 18.19 GB peak of
// which vitest was 11.45 GB, across SIX concurrent runners and 28 workers, none of them holding a slot.
//
// Tested here rather than in the runner because the runner cannot be exercised without actually
// building: the rule has to be a pure function precisely so the next scope exemption is forced to answer
// this question too.
describe("needsGateSlot", () => {
  it("takes a slot for a full gate — unchanged", () => {
    expect(needsGateSlot({ full: true, runVitest: true })).toBe(true);
  });

  it("takes a slot for a SCOPED gate that runs the whole vitest suite — the regression", () => {
    // A record-store change sets `vitestUnscoped` because `--changed` cannot see from a JSON blob to the
    // modules `emit:records` materializes out of it. Running unscoped there is correct; inheriting the
    // cheap tier's exemption while doing it was not.
    expect(needsGateSlot({ full: false, runVitest: true, vitestUnscoped: true })).toBe(true);
  });

  it("does NOT queue a genuinely scoped gate — the exemption still has to be worth having", () => {
    // This is the case the exemption was written for: a narrow vitest run beside one crate's compile.
    // If this ever returns true the fleet serializes on everything and the tiering is pointless.
    expect(needsGateSlot({ full: false, runVitest: true, vitestUnscoped: false })).toBe(false);
  });

  it("does not queue a plan that runs no vitest at all, however it is flagged", () => {
    // A Rust-only change carries `vitestUnscoped: undefined`; a no-op plan carries `runVitest: false`.
    // Neither spawns a worker pool, so neither should wait behind one.
    expect(needsGateSlot({ full: false, runVitest: false, vitestUnscoped: true })).toBe(false);
    expect(needsGateSlot({ full: false, runVitest: false })).toBe(false);
  });

  it("answers false for a missing plan rather than throwing", () => {
    // The runner calls this before anything else has validated the plan; a throw here would take out the
    // gate itself, which is strictly worse than running one unserialized.
    expect(needsGateSlot(undefined)).toBe(false);
  });

  it("agrees with a REAL plan built by planGate for a record-store change", () => {
    // The unit assertions above use hand-made plans, which can drift from what planGate actually emits.
    // This pins the join: touching a record store must produce a plan that needs a slot.
    const plan = planGate({
      files: ["src-tauri/data/components/app/features/designs/guidecard.json"],
      graph, dirToCrate, exists: () => true,
    });
    expect(plan.full).toBe(false);
    expect(plan.vitestUnscoped).toBe(true);
    expect(needsGateSlot(plan), "a scoped plan running the whole suite must queue").toBe(true);
  });
});

// Every leg is MEASURED, and the id it is measured under has to be stable — see `gateCommands`.
describe("gate legs carry a stable measurement key", () => {
  const full = gateCommands({ full: true }, "develop");
  const scoped = gateCommands(
    { full: false, runTsc: true, frontendFiles: ["src/a.ts"], runVitest: true, vitestUnscoped: false,
      rustCrates: ["bsc-util"], runGraph: true },
    "develop",
  );

  it("gives EVERY leg a key and a stage, so none is silently unmeasured", () => {
    for (const leg of [...full, ...scoped]) {
      expect(leg.key, `no key on "${leg.label}"`).toBeTruthy();
      expect(leg.stage, `no stage on "${leg.label}"`).toBeTruthy();
    }
  });

  it("uses only stages the fault taxonomy already knows", () => {
    // A stage `errordb` does not recognise is refused by `bsc errors run`, which would turn a measured
    // leg into a failed one — the gate breaking on its own instrumentation.
    const KNOWN = ["install", "compile", "typecheck", "lint", "test", "build", "package", "deploy", "launch", "runtime", "supply"];
    for (const leg of [...full, ...scoped]) expect(KNOWN).toContain(leg.stage);
  });

  // THE POINT OF SPLITTING key FROM label. The label moves between a scoped and a full run ("vitest"
  // vs "vitest (--changed: module-graph affected)"); filing measurements under it would split one
  // surface into two histories that can never be compared, which is what makes a trend worthless.
  it("keys a scoped leg and its full-run twin identically, even though the labels differ", () => {
    const pair = (key: string) => [full, scoped].map((set) => set.find((l) => l.key === key));
    for (const key of ["vitest", "clippy", "nextest", "typecheck", "lint"]) {
      const [f, sc] = pair(key);
      expect(f, `full run has no ${key}`).toBeTruthy();
      expect(sc, `scoped run has no ${key}`).toBeTruthy();
      expect(f!.key).toBe(sc!.key);
      expect(f!.stage).toBe(sc!.stage);
    }
    expect(scoped.find((l) => l.key === "vitest")!.label).not.toBe(full.find((l) => l.key === "vitest")!.label);
  });
});
