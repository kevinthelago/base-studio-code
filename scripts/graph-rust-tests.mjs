#!/usr/bin/env node
/**
 * `node scripts/graph-rust-tests.mjs` — the Rust EDGE tier's two-copy invariant.
 *
 * An edge whose `src` is `crates/<c>/tests/<name>.rs` carries a whole cargo integration-test target.
 * `crates/graph-materialize` materializes it into `$OUT_DIR/tests/<name>.rs`, and the crate reaches it
 * with `[[test]] name = "<name>" path = "../graph-materialize/test_root.rs"` — so `cargo nextest`
 * compiles and runs it exactly as it runs a file
 * (`a-rust-record-test-runs-and-an-edge-reaches-the-seed`).
 *
 * # Why a whole-tree guard, and not only unit tests
 *
 * The unit tests in `crates/graph-materialize/src/test_targets.rs` pin the RULES. What no unit test
 * can see is the TREE: whether the record and the file it was lifted from still agree, and whether a
 * migrated target is still declared. Both failures are silent and both are this repo's signature
 * shape — a green gate covering less than the reader assumes.
 *
 *   * DRIFT. Five of the six Rust edges still have their file on disk, as EVIDENCE. Cargo runs the
 *     file; the record is a second copy, free to rot, and a reader looking at the graph would be
 *     reading assertions that no longer run. Byte-equality is the only honest reading of "the record
 *     IS that file".
 *   * A MIGRATED TARGET THAT STOPPED RUNNING. Delete the file, forget the `[[test]]` entry, and
 *     nothing fails: the test simply is not compiled any more, and the suite reports all-passing with
 *     fewer tests in it. That is exactly how eight vitest files were dropped behind a green gate.
 *   * A DECLARED TARGET WITH NO EDGE. `$OUT_DIR` is not cleaned between builds, so a stale generated
 *     file keeps satisfying an orphaned `[[test]]` entry — the target would go on running content the
 *     store no longer holds.
 *
 * Reads the COMMITTED store (`graph/algorithms.json`), which is what the build compiles, never the
 * shared runtime store — so another session's in-progress authoring cannot redden this for everyone.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SHARED_TEST_ROOT = "../graph-materialize/test_root.rs";

/**
 * The `[[test]]` targets a Cargo manifest declares that point at the SHARED root, as
 * `{ name, path }`.
 *
 * A hand parser rather than a TOML dependency, and narrow on purpose: it reads only the `[[test]]`
 * array-of-tables, only `name` and `path`, and only their basic-string form — which is every one this
 * repo writes. Anything it cannot read is reported by the caller as "no target declared", which fails
 * LOUD rather than passing quietly; a parser that silently matches nothing reports zero offenders,
 * and that reads as a pass.
 */
export function declaredTestTargets(manifest) {
  const out = [];
  let inTest = false;
  let cur = null;
  for (const raw of manifest.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      if (cur) out.push(cur);
      cur = null;
      inTest = line === "[[test]]";
      if (inTest) cur = { name: null, path: null };
      continue;
    }
    if (!inTest || !cur) continue;
    const m = /^(name|path)\s*=\s*"([^"]*)"/.exec(line);
    if (m) cur[m[1]] = m[2];
  }
  if (cur) out.push(cur);
  return out.filter((t) => t.name);
}

/** The Rust test-target edges of a store: `{ id, crateDir, name, src, bodies }`. */
export function rustTestEdges(store) {
  const out = [];
  for (const e of store.edges ?? []) {
    const src = typeof e.src === "string" ? e.src : "";
    const m = /^crates\/([^/]+)\/tests\/([^/]+)\.rs$/.exec(src);
    if (!m) continue;
    out.push({
      id: e.id ?? "(no id)",
      crateDir: m[1],
      name: m[2],
      src,
      bodies: (e.tests ?? []).map((t) => t?.src).filter((s) => typeof s === "string" && s.trim()),
    });
  }
  return out;
}

/**
 * Every violation, as a printable line. PURE — the tree is passed in as `{ read, exists }` so the
 * script's own test can drive every branch without a fixture tree on disk.
 *
 * @param {{edges: ReturnType<typeof rustTestEdges>, manifests: Map<string,string>, exists: (p: string) => boolean}} tree
 */
export function violations({ edges, manifests, exists }) {
  const bad = [];
  const declaredBy = new Map();
  for (const [crateDir, manifest] of manifests) {
    for (const t of declaredTestTargets(manifest)) {
      if (t.path === SHARED_TEST_ROOT) declaredBy.set(`${crateDir}/${t.name}`, true);
    }
  }
  const edgeFor = new Set(edges.map((e) => `${e.crateDir}/${e.name}`));

  for (const e of edges) {
    const key = `${e.crateDir}/${e.name}`;
    const onDisk = exists(e.src);
    if (e.bodies.length !== 1) {
      bad.push(
        `${e.id} — carries ${e.bodies.length} test bodies but names ONE cargo test target (${e.src}). ` +
          `A test target is one file.`
      );
      continue;
    }
    if (onDisk && declaredBy.has(key)) {
      bad.push(
        `${e.id} — ${e.src} is BACK on disk while its crate also declares a [[test]] target for it. ` +
          `Cargo would compile the file and the record's copy could differ. Delete the file.`
      );
      continue;
    }
    if (!onDisk && !declaredBy.has(key)) {
      bad.push(
        `${e.id} — ${e.src} is gone and no [[test]] target reaches the record, so this test RUNS ` +
          `NOWHERE. Add to crates/${e.crateDir}/Cargo.toml:\n` +
          `        [[test]]\n        name = "${e.name}"\n        path = "${SHARED_TEST_ROOT}"`
      );
    }
  }
  // The other direction: a declared target whose edge has gone. `$OUT_DIR` is not cleaned between
  // builds, so the stale generated file would keep the target compiling against content the store no
  // longer holds.
  for (const key of declaredBy.keys()) {
    if (!edgeFor.has(key)) {
      const [crateDir, name] = key.split("/");
      bad.push(
        `crates/${crateDir}/Cargo.toml declares [[test]] name = "${name}" against the shared root, but ` +
          `no edge in the committed store carries crates/${crateDir}/tests/${name}.rs. A stale ` +
          `$OUT_DIR copy would keep it compiling. Drop the target, or re-promote the edge.`
      );
    }
  }
  return bad;
}

/** Where a record and the file it names DISAGREE — byte-for-byte. */
export function drifted(edges, read) {
  const out = [];
  for (const e of edges) {
    if (e.bodies.length !== 1) continue;
    const file = read(e.src);
    if (file === null) continue; // migrated; `violations` owns that case
    if (file !== e.bodies[0]) {
      out.push(
        `${e.id} — the record and ${e.src} have DRIFTED. Cargo runs the file, so the record's copy is ` +
          `assertions nobody executes. Re-harvest it (\`bsc graph edge set --id ${e.id} --src ${e.src}\`) ` +
          `and promote, or migrate the test (delete the file, declare the [[test]] target).`
      );
    }
  }
  return out;
}

/** @returns {{ ok: boolean, lines: string[], checked: number, migrated: number }} */
export function audit(repo) {
  const store = JSON.parse(readFileSync(join(repo, "graph/algorithms.json"), "utf8"));
  const edges = rustTestEdges(store);
  const manifests = new Map();
  for (const d of readdirSync(join(repo, "crates"), { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const p = join(repo, "crates", d.name, "Cargo.toml");
    if (existsSync(p)) manifests.set(d.name, readFileSync(p, "utf8"));
  }
  const exists = (rel) => existsSync(join(repo, rel));
  const read = (rel) => (exists(rel) ? readFileSync(join(repo, rel), "utf8") : null);
  const lines = [...violations({ edges, manifests, exists }), ...drifted(edges, read)];
  const migrated = edges.filter((e) => !exists(e.src)).length;
  // NON-VACUITY. An empty store and a store nothing matched look identical from here, and a check
  // that passes by finding nothing is the vacuous green this repo keeps getting caught by.
  if (edges.length === 0) {
    lines.push(
      "no edge in the committed store names a crates/*/tests/*.rs target — this check verified NOTHING. " +
        "Either the Rust edge tier was emptied, or `rustTestEdges` stopped matching its own store."
    );
  } else if (migrated === 0) {
    lines.push(
      `all ${edges.length} Rust test edges still have their file on disk, so NOT ONE is executed from ` +
        "the graph. The migrated case is the one this capability exists for; if the last migrated " +
        "target was reverted, say so on the item rather than leaving this check vacuous."
    );
  }
  return { ok: lines.length === 0, lines, checked: edges.length, migrated };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { ok, lines, checked, migrated } = audit(repo);
  if (!ok) {
    console.error("graph (rust test edges):\n  " + lines.join("\n  "));
    process.exit(1);
  }
  console.log(`graph (rust test edges): ${checked} edge(s), ${migrated} executed from the graph — ok`);
}
