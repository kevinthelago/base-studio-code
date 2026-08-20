#!/usr/bin/env node
/**
 * `node scripts/graph-rust-compile.mjs` — compile every Rust node in the algorithms graph, alone.
 *
 * A node claims to be a self-contained implementation. Nothing has ever checked that claim for Rust:
 * `bsc graph test` is hardcoded TypeScript (it writes `{stem}.ts` and runs vitest), so a Rust node has
 * never been executed or even parsed. This sweep is the missing oracle — and a compile is the one
 * check that cannot be fooled by a regex being more permissive than the real thing.
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
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { homedir } from "node:os";

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
  const { impls, byId } = loadStore();
  const work = join(tmpdir(), "bsc-graph-rust-sweep");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, "out"), { recursive: true });

  const nodes = impls.filter((i) => i.tech === "rust" && i.role === "algorithm" && (i.code ?? "").trim());
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
  for (const f of failures) {
    process.stdout.write(`\n  ✗ ${f.id}  ${f.codes}\n`);
    const first = f.stderr.split("\n").filter((l) => l.startsWith("error")).slice(0, 2);
    for (const l of first) process.stdout.write(`      ${l}\n`);
  }
  if (process.env.BSC_SWEEP_KEEP) process.stdout.write(`\nmaterialized sources kept in ${work}\n`);
  process.exit(failures.length ? 1 : 0);
}
