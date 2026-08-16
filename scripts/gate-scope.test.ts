// The scope decision for `npm run gate`
// (#the-gate-runs-everything-on-every-item-regardless-of-what-changed).
//
// Worth testing properly rather than eyeballing, because the failure mode is SILENT: a scope that comes
// out too small does not error, it just runs less and reports green. That is the exact shape of every
// gate incident this repo has recorded — tsc+lint+vitest green with a live Worker deleted, ten
// stylesheets orphaned with every gate green, and a vitest config change that dropped 8 test files while
// reporting all-passing.
import { describe, it, expect } from "vitest";
import { planGate, withDependents, crateForPath, isFrontendPath, parsePorcelain, gateCommands, FORCE_FULL } from "./gateScope.mjs";

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
});
