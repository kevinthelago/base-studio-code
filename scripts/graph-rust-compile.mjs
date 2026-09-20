#!/usr/bin/env node
/**
 * `node scripts/graph-rust-compile.mjs` — compile every Rust node in the algorithms graph, alone.
 *
 * A node claims to be a self-contained implementation. A compile is the one check of that claim which
 * cannot be fooled by a regex being more permissive than the real thing.
 *
 * # THIS IS THE FAST SWEEP, NOT THE AUTHORITY
 *
 * The convention below is implemented TWICE on purpose, and the other copy is the authority:
 * `crates/bsc-graph/src/rust_test.rs`, reached as `bsc algorithms test <id> --run`. That one materializes a
 * real crate and runs `cargo`, so it can execute a node's paired tests; this one drives `rustc` per
 * file and can only answer "does it compile".
 *
 * The split is a MEASURED speed trade, not an accident: rustc-per-file sweeps all 83 nodes in ~9.4s,
 * while a materialized crate costs 5.51s cold / 1.66s warm EACH — about 2m20s for the same set. A gate
 * wants the 9.4s answer.
 *
 * **So the two must move together.** If you change the closure convention here, change it there, and
 * vice versa — the Rust side carries the unit tests that pin it. Folding these into one implementation
 * (a fast `--all --tech rust` mode on the verb, and deleting this file) belongs to `the-graph-gets-a-gate`.
 *
 * # The materialization convention, and why it is FLAT
 *
 * The obvious shape — one composed record per submodule — is WRONG for this library, and getting it
 * wrong reports the records as broken when the harness is. Measured: the records call their composed
 * siblings by BARE NAME (`magnitude` calls `dot_product(v, v)`, not `crate::dot_product::dot_product`).
 * So the whole `role:algorithm` closure is concatenated into ONE flat scope, exactly as if it were one
 * module. The single record that does use a qualified path (`merge-sort.rs` -> `use crate::merge::merge;`)
 * needs no module either: under a flat scope the sibling is already in scope, so those lines are dropped.
 *
 * `role:primitive` members are NOT materialized — a primitive DESCRIBES a language built-in via `--ref`
 * and is never re-coded (#2972). Instead its `ref` supplies the import: `rust.hashmap` carries
 * `std::collections::HashMap`, so the closure emits `use std::collections::HashMap;`. A `ref` with no
 * `::` (`i64`, `bool`, `f64`, `&[T]`) is a language primitive needing no import at all.
 *
 * That is the point of the sweep: the imports a node needs are DERIVABLE from data already on the node,
 * so a node missing one is a real defect and not a stylistic gap.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
// The MERGED store loader (`epic-retire-json-ledgers-for-db-and-git-drivers`). Aliased because this
// module exports a `loadStore` of its own with different semantics — that one takes a store path or
// falls back to the per-user RUNTIME store; this one merges a store file with the per-record files
// beside it.
import { loadStore as loadMergedStore, resolveStorePath } from "./lib/recordStore.mjs";

/**
 * The store is read ONLY by the CLI block below, never at import time: these helpers are pure so a test
 * can exercise them without this machine's store existing. A verifier that reads real state on import
 * cannot run in a fresh clone, which is the same trap `record-link-verifier` avoided by not evaluating.
 */
export function loadStore(path) {
  const store =
    path ||
    process.env.BSC_GRAPH_STORE ||
    join(homedir(), ".base-studio-code", "knowledge", "algorithms.json");
  const graph = JSON.parse(readFileSync(store, "utf8"));
  const impls = graph.implementations ?? graph;
  return { impls, byId: new Map(impls.map((i) => [i.id, i])) };
}

/** Merge implementation lists, later sources winning by id. */
export function mergeById(...lists) {
  const by = new Map();
  for (const list of lists) for (const impl of list ?? []) if (impl?.id) by.set(impl.id, impl);
  return { impls: [...by.values()], byId: by };
}

/**
 * What the GATE sweeps — the two COMMITTED, in-repo sources, never the per-user runtime store.
 *
 * This is the repo's established rule for a guard (the-store-is-the-copy-that-breaks-the-app): a check
 * that reads `~/.base-studio-code` cannot run in a fresh clone, in CI, or in any worktree whose agent
 * never authored a record, and it would report a machine's private state as a repo failure. So the gate
 * reads the packaged seed plus the committed repo store; the repo store wins on a shared id, since it
 * is the one the build is meant to compile.
 *
 * `BSC_GRAPH_STORE` still overrides, which is how a developer sweeps their full runtime library locally.
 */
export function loadGateSources(root) {
  if (process.env.BSC_GRAPH_STORE) return loadStore(process.env.BSC_GRAPH_STORE);
  const read = (p) => {
    try {
      const g = JSON.parse(readFileSync(p, "utf8"));
      return g.implementations ?? g;
    } catch {
      return []; // absent is legitimate: a repo may have migrated nothing yet
    }
  };
  const readMerged = (p) => {
    try {
      return loadMergedStore(p).implementations ?? [];
    } catch {
      return []; // same rule: absent is legitimate
    }
  };
  // The seed is ONE file by design; the repo store is a file PLUS `graph/records/<id>.json` per
  // record, so it goes through the merged loader. Reading it with `read` saw an empty
  // `implementations` array the day the records split out — and this function SWALLOWS errors and
  // returns `[]`, so the sweep would have reported "0 nodes, 0 failures" and exited green.
  const seedPath = join(root, "src-tauri", "data", "knowledge", "algorithms.json");
  // Through the MARKER, not a hard-coded name: `graph/store.toml` decides what the committed store
  // is, and this reader swallows its errors into `[]` — so a wrong path here degrades to "0 nodes,
  // 0 failures" and exits green rather than saying it read nothing.
  const storePath = resolveStorePath(root);
  const seed = read(seedPath);
  const store = readMerged(storePath);
  // A POPULATION FLOOR PER SOURCE, because both readers above swallow their errors and return `[]` —
  // right for "this repo has migrated nothing yet", catastrophic for "the read stopped working".
  //
  // PER SOURCE, not on the merge, and that distinction is the whole value: MEASURED when the repo
  // store split into per-record files and this function still read only the store FILE, the repo half
  // fell to ZERO while the packaged seed kept the merged total near 700 — so a floor on the total saw
  // nothing, and `graph-cross-kit` fell from 39 cases to 5 and exited 0. A check that silently covers
  // an eighth of what its reader assumes is this repo's signature failure.
  //
  // Each floor is far below its real population (~670 seed records, 1,726 committed) on purpose: this
  // detects a COLLAPSE, not a record going missing. Only a source whose file EXISTS is floored — a
  // checkout that has migrated nothing is legitimate — and `BSC_GRAPH_STORE` returns early above, so a
  // test pointing at a small temp store never reaches here.
  const floor = (label, path, impls, min) => {
    if (existsSync(path) && impls.length < min) {
      throw new Error(
        `the gate's ${label} collapsed to ${impls.length} implementation(s) (floor ${min}) — ${path} ` +
          `exists, so this is a READ that stopped working, not an empty repo. Every check fed by it ` +
          `would pass over nothing and report green.`,
      );
    }
  };
  floor("packaged seed", seedPath, seed, 300);
  floor("committed repo store", storePath, store, 500);
  return mergeById(seed, store);
}

/** The line a crate adds to its manifest when it owns no build script of its own. */
export const MATERIALIZE_MARKER = 'build = "../graph-materialize/build.rs"';

/**
 * The OTHER route into the same materializer, and missing it is a SILENT UNDER-REPORT.
 *
 * A package gets exactly ONE build script, so a crate that already has one cannot point `build =`
 * anywhere — it takes `graph-materialize` as a build-dependency and calls it from its own `build.rs`
 * (`the-two-build-rs-crates-adopt-the-materializer-alongside-their-own`). `crates/data` and
 * `crates/bsc-config` do exactly that, and neither carries `MATERIALIZE_MARKER`.
 *
 * MEASURED the moment those two migrated, with only the marker checked: 20 healthy Tier-A records
 * dropped out of the exclusion, this sweep built them standalone, and reported **16 FAILED** with
 * `unresolved import bsc_cli_util` / `cannot find module or crate serde_json`. Every one of those is
 * the sweep asking a whole crate module to compile alone — the exact libel the Tier-A split exists to
 * prevent — and nothing about the records had changed.
 */
export const MATERIALIZE_DEP = 'graph-materialize = { path = "../graph-materialize" }';

/**
 * Is `graph-materialize` a key of this manifest's `[build-dependencies]` table?
 *
 * SECTION-SCOPED, and a whole-file `includes` is wrong in the other direction. `crates/bsc-graph`
 * takes the same package as a **dev**-dependency — its tests drive the shipped symbols rather than a
 * restatement — while its own source is NOT materialized. A whole-file check reported it Tier A, which
 * would have EXCLUDED its records from this sweep: the quieter failure of the two, since a record that
 * is never swept never reports anything at all.
 *
 * Matches the KEY, not `MATERIALIZE_DEP` verbatim, because `src-tauri` reaches the same package at
 * `../crates/graph-materialize` — the path is not part of the question. A test pins that the exact
 * line the migration writes satisfies this.
 */
export function takesMaterializerAsBuildDependency(cargoToml) {
  let inside = false;
  for (const line of cargoToml.split("\n")) {
    const t = line.trim();
    if (t.startsWith("[")) {
      inside = t === "[build-dependencies]";
      continue;
    }
    if (inside && t.startsWith("graph-materialize")) return true;
  }
  return false;
}

/**
 * Crate directories whose source lives in the graph — read from each crate's OWN manifest.
 *
 * These carry Tier-A records: a whole crate module, compiled INSIDE its crate against its dependencies.
 * Sweeping one as a standalone Tier-R node is a category error, and a loud one — `bsc-blueprint-cli.rs`
 * fails with `cannot find module or crate bsc_json_store`, which is correct rather than a defect. The
 * tier is still decided by the compile; this only keeps a record out of a population it never joined.
 *
 * Derived, never hand-maintained: a crate is in this set exactly when its manifest opts in, so the list
 * cannot drift from reality the way a literal would. **Both** opt-in routes count — see
 * `MATERIALIZE_DEP` for what checking only one of them costs.
 */
export function materializedCrates(crateDirs, readManifest) {
  const out = new Set();
  for (const dir of crateDirs) {
    const text = readManifest(dir);
    if (typeof text !== "string") continue;
    if (text.includes(MATERIALIZE_MARKER) || takesMaterializerAsBuildDependency(text)) out.add(dir);
  }
  return out;
}

/**
 * The crate DIRECTORY a record's `src` belongs to, REPO-RELATIVE — `crates/plandb`, `src-tauri`.
 *
 * Repo-relative rather than a bare crate NAME, and that is the whole fix. A crate does not have to
 * live under `crates/`: `src-tauri` sits one level up, so a `^crates/` match returned nothing for all
 * 138 of its records the moment it migrated, none of them were excluded, and this sweep built whole
 * crate modules standalone — MEASURED at `src-tauri-compiles-from-the-graph`: **119 FAILED** with
 * `unresolved import tauri`, which is the sweep asking a crate module to compile alone rather than any
 * defect in a record. Exactly the silent under-report `MATERIALIZE_DEP` documents, one level further
 * out: that constant was already written FOR `src-tauri`, but the directory half never followed.
 *
 * A directory is also the key nothing can collide in — it is what a manifest is read from — where a
 * bare name would put a hypothetical top-level `data/` and `crates/data/` in one bucket.
 */
export function crateDirOf(src) {
  if (typeof src !== "string") return null;
  const i = src.indexOf("/src/");
  return i > 0 ? src.slice(0, i) : null;
}

/** Does this record's `src` belong to a crate that materializes its source? */
export function isMaterializedModule(src, crates) {
  const dir = crateDirOf(src);
  return dir ? crates.has(dir) : false;
}

/** Transitive closure of a node, split into the code to materialize and the primitives to import. */
export function closureOf(rootId, lookup) {
  const seen = new Set();
  const algorithms = [];
  const primitives = [];
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const rec = lookup.get(id);
    if (!rec) continue;
    if (rec.role === "primitive") {
      primitives.push(rec);
      continue; // a primitive is std — never re-coded, only imported
    }
    algorithms.push(rec);
    for (const dep of rec.composes ?? []) stack.push(dep);
  }
  return { algorithms, primitives };
}

/**
 * Names a body already imports, including the braced form `use std::collections::{HashMap, HashSet};`.
 * A primitive-derived import must not restate one of these — rustc rejects the duplicate (E0252), and
 * that is the harness's error to avoid, not a defect in the record.
 */
export function importedNames(code) {
  const names = new Set();
  for (const m of code.matchAll(/^\s*use\s+([^;]+);/gm)) {
    const path = m[1];
    const braced = path.match(/\{([^}]*)\}/);
    if (braced) for (const part of braced[1].split(",")) names.add(part.trim().split("::").pop());
    else names.add(path.trim().split("::").pop());
  }
  names.delete("");
  return names;
}

/**
 * `use` lines a closure's primitives imply, minus anything the code already imports.
 * A ref without `::` is a language primitive (`i64`, `bool`, `&[T]`) and needs no import at all.
 */
export function importsFor(primitives, existing = new Set()) {
  const paths = primitives
    .map((p) => p.ref)
    .filter((r) => typeof r === "string" && r.includes("::"))
    .filter((r) => !existing.has(r.split("::").pop()));
  return [...new Set(paths)].sort().map((p) => `use ${p};`);
}

/** A sibling is already in scope under flat materialization, so its qualified import is noise. */
const dropCrateUses = (code) =>
  code.replace(/^\s*use\s+(crate|super|self)::[^;]*;\s*$/gm, "");

/** One node + its closure as a single compilable Rust module. */
export function materialize(rootId, lookup) {
  const { algorithms, primitives } = closureOf(rootId, lookup);
  // root last: definition order does not matter to rustc, but it keeps the file readable
  const ordered = [
    ...algorithms.filter((a) => a.id !== rootId),
    ...algorithms.filter((a) => a.id === rootId),
  ];
  const bodies = ordered.map((a) => dropCrateUses(a.code ?? ""));
  return [
    "#![allow(dead_code, unused_imports, unused_mut)]",
    ...importsFor(primitives, importedNames(bodies.join("\n"))),
    "",
    ...bodies,
    "",
  ].join("\n");
}

// Run only as a CLI, never on import — the tests import the pure helpers above.
if (process.argv[1]?.endsWith("graph-rust-compile.mjs")) {
  // The repo root: this file lives in <root>/scripts/.
  const root = join(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..");
  const { impls, byId } = loadGateSources(root);
  const work = join(tmpdir(), "bsc-graph-rust-sweep");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, "out"), { recursive: true });
  // Removed on the way out, whatever the way out is — either `process.exit` below, a normal end, or a
  // throw. The gate's temp-leaks leg caught this directory surviving every run
  // (`the-test-suites-still-leak-temp-entries-per-gate`).
  process.on("exit", () => rmSync(work, { recursive: true, force: true }));

  // NOT wrapped in a catch. An earlier version swallowed everything here, which turned a missing import
  // into an empty crate list — the filter silently did nothing and the sweep failed on a record it
  // should never have swept. A broad catch around a lookup is how a guard quietly stops guarding.
  // EVERY crate directory, not only the ones under `crates/`. A workspace member is any directory
  // holding a `Cargo.toml`, and `src-tauri` is one of them — see `crateDirOf` for what missing it cost.
  // Derived by looking for the manifest rather than naming `src-tauri`, so the next crate that lands
  // outside `crates/` is covered without anyone remembering a literal.
  const crateDirs = [
    ...readdirSync(join(root, "crates"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => `crates/${e.name}`),
    ...readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== "crates" && !e.name.startsWith("."))
      .map((e) => e.name)
      .filter((name) => existsSync(join(root, name, "Cargo.toml"))),
  ];
  const materialized = materializedCrates(crateDirs, (dir) => {
    try {
      return readFileSync(join(root, dir, "Cargo.toml"), "utf8");
    } catch {
      return null;
    }
  });

  const all = impls.filter((i) => i.tech === "rust" && i.role === "algorithm" && (i.code ?? "").trim());
  const nodes = all.filter((i) => !isMaterializedModule(i.src, materialized));
  const skipped = all.length - nodes.length;

  // HASH-CACHE. The gate runs on every commit while iterating, and re-compiling an unchanged library
  // to reach the same verdict is pure waste. The key covers what can change the answer: every swept
  // node's materialized source, and the compiler that judges it. `--no-cache` forces a real run.
  //
  // Infrastructure failures are SWALLOWED (a missing rustc version, an unwritable target dir) because a
  // cache is an optimization; a RED NODE is never swallowed, which is the asymmetry `gc` also follows.
  const rustcVersion = (() => {
    try {
      return execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim();
    } catch {
      return "unknown-rustc";
    }
  })();
  const key = createHash("sha256")
    .update(rustcVersion)
    .update(nodes.map((n) => `${n.id} ${materialize(n.id, byId)}`).sort().join(""))
    .digest("hex")
    .slice(0, 16);
  const stamp = join(root, "target", `.graph-rust-sweep-${key}`);
  const useCache = !process.argv.includes("--no-cache");
  if (useCache && existsSync(stamp)) {
    process.stdout.write(`\nrust nodes swept: ${nodes.length}   compiled: ${nodes.length} (cached, unchanged)\n`);
    process.exit(0);
  }

  const failures = [];
  const started = Date.now();

  for (const node of nodes) {
    // The id already carries `.rs`; a second one makes the crate name `merge.rs`, which rustc rejects.
    const crateName = node.id.replace(/\.rs$/, "").replace(/[^\w]/g, "_");
    const file = join(work, `${crateName}.rs`);
    writeFileSync(file, materialize(node.id, byId), "utf8");
    try {
      execFileSync("rustc", ["--edition", "2021", "--crate-type", "lib", "--out-dir", join(work, "out"), file], {
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (err) {
      const stderr = String(err.stderr ?? "");
      const codes = [...stderr.matchAll(/^error(\[[A-Z0-9]+\])?/gm)].map((m) => m[1] ?? "error");
      failures.push({ id: node.id, codes: [...new Set(codes)].join(" "), stderr });
    }
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const pass = nodes.length - failures.length;
  process.stdout.write(`\nrust nodes swept: ${nodes.length}   compiled: ${pass}   FAILED: ${failures.length}   (${secs}s)\n`);
  // A skip nobody is told about is how a caller comes to believe a record was checked when it was not.
  if (skipped) {
    process.stdout.write(
      `  (${skipped} Tier-A record(s) skipped — their crate materializes its source, so they compile ` +
        `INSIDE it against its dependencies, never standalone)\n`,
    );
  }
  for (const f of failures) {
    process.stdout.write(`\n  ✗ ${f.id}  ${f.codes}\n`);
    const first = f.stderr.split("\n").filter((l) => l.startsWith("error")).slice(0, 2);
    for (const l of first) process.stdout.write(`      ${l}\n`);
  }
  if (process.env.BSC_SWEEP_KEEP) process.stdout.write(`\nmaterialized sources kept in ${work}\n`);
  // Stamp only a GREEN sweep: caching a failure would hide it on the next run, which is the precise
  // shape of gate-passes-while-covering-less this repo keeps paying for.
  if (!failures.length && useCache) {
    try {
      mkdirSync(join(root, "target"), { recursive: true });
      writeFileSync(stamp, `${new Date().toISOString()} ${rustcVersion}\n`, "utf8");
    } catch {
      /* a cache that cannot be written is not a failure — the sweep already gave its verdict */
    }
  }
  process.exit(failures.length ? 1 : 0);
}
