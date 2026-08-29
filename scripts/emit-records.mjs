// Materialize retired modules from their packaged seeds into a generated, git-ignored tree.
//
// WHY NOT A BUNDLER PLUGIN. I wrote one first, and deleting a single file proved it insufficient in three
// different ways at once:
//
//   vite build  — failed on `'./layout/Spacer'`, a RELATIVE import. A plugin matching `@/…` never sees it.
//   tsc         — TS2307 from three files. The type checker has no plugin API of this kind; it resolves
//                 modules its own way and knows nothing about Vite.
//   vitest      — has its OWN config, so the plugin was never loaded, and the colocated test imported
//                 `./Spacer` besides.
//
// Three resolvers, three mechanisms, and a plugin only ever fixes one. The thing all three DO agree on is
// a file on disk. So instead of teaching each tool about records, emit the record AS a file into a
// generated tree and let `tsconfig.paths` fallback order do the rest:
//
//     "@/*": ["src/*", ".bsc-records/*"]     // src wins; the record answers only what src no longer has
//
// tsc supports that natively, Vite and vitest can be given the same two-step resolve, and a relative
// import resolves because the emitted file sits at the same relative position in the mirrored layout.
//
// ⚠️ THIS IS NOT "MOVING THE FILE". The emitted tree is GIT-IGNORED and regenerated from the seed on every
// build/typecheck/test. The repository genuinely loses the module; what exists on disk afterwards is a
// derived cache, the same status `node_modules` has. If the emitted copy is ever edited, the next run
// overwrites it — the seed is the source of truth, which is the entire point of the migration.
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, statSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { relativeSpecifiers, aliasForDir } from "./lib/recordSource.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(REPO, ".bsc-records");

/** Every specifier a packaged seed can serve, with the source to serve for it. */
function collectSeeds() {
  const out = new Map();
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!e.name.endsWith(".json")) continue;
      if (statSync(p).size > 4_000_000) continue; // the generated kit closure, not a per-record seed
      let rec;
      try {
        rec = JSON.parse(readFileSync(p, "utf8"));
      } catch {
        continue;
      }
      const spec = typeof rec?.provides === "string" ? rec.provides.trim() : "";
      const code = typeof rec?.srcText === "string" ? rec.srcText : "";
      if (spec.startsWith("@/") && code.trim() && rec.id)
        out.set(spec, { id: rec.id, code, tests: Array.isArray(rec.tests) ? rec.tests : [] });
    }
  };
  walk(join(REPO, "src-tauri", "data", "components"));

  try {
    const k = JSON.parse(readFileSync(join(REPO, "src-tauri", "data", "knowledge", "algorithms.json"), "utf8"));
    for (const im of k?.implementations ?? []) {
      const spec = typeof im?.provides === "string" ? im.provides.trim() : "";
      const code = typeof im?.code === "string" ? im.code : "";
      // Components win a collision — `resolveGraphSource` checks them first, so the emitted tree must agree
      // with what the runtime loader would have picked.
      if (spec.startsWith("@/") && code.trim() && im.id && !out.has(spec))
        out.set(spec, { id: im.id, code, tests: Array.isArray(im.tests) ? im.tests : [] });
    }
  } catch {
    /* a checkout without the algorithm seed is still valid */
  }
  return out;
}

/** The graph's EDGES (integration-tests-become-graph-edges), or `[]`.
 *
 *  Read separately from {@link collectSeeds} because an edge is not a module: it has no `provides`, emits
 *  no source, and is keyed by its own id rather than by a specifier. Folding it into the specifier map
 *  would make an edge compete with a record for a key it does not own. */
function collectEdges() {
  try {
    const k = JSON.parse(readFileSync(join(REPO, "src-tauri", "data", "knowledge", "algorithms.json"), "utf8"));
    return Array.isArray(k?.edges) ? k.edges : [];
  } catch {
    return [];
  }
}

/** Does `src/` still hold this specifier? If so the record must NOT be emitted — the file wins. */
function fileExists(spec) {
  const base = join(REPO, "src", ...spec.slice(2).split("/"));
  return [".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts"].some((e) => existsSync(base + e));
}

/** JSX needs `.tsx`; a module without it gets `.ts` so `tsc` does not widen every generic to a JSX tag. */
const extFor = (code) => (/<[A-Za-z][^>]*>/.test(code) ? ".tsx" : ".ts");

/** Does `src/` still hold a COLOCATED TEST for this specifier?
 *
 *  The same "src wins" rule the module itself follows, and it is what makes the migration incremental
 *  rather than a flag day. While `src/x/y.test.tsx` exists it is the copy that runs; emitting the record's
 *  carried test as well would run the same assertions TWICE and double-count them, so a record's tests are
 *  emitted only once the file is gone. Deleting the file is therefore the whole handover — the carried
 *  test takes over on the next emit, with no third state in between. */
function testFileExists(spec) {
  const base = join(REPO, "src", ...spec.slice(2).split("/"));
  return [".test.tsx", ".test.ts", ".spec.tsx", ".spec.ts"].some((e) => existsSync(base + e));
}

/** Normalize a relative specifier against the directory it is imported FROM, in specifier terms.
 *  `./Button` from `shared/ui/controls` → `shared/ui/controls/Button`; `../lib/x` → `shared/ui/lib/x`.
 *
 *  Delegates to the shared `aliasForDir` and strips the `@/` back off, so the emitter's idea of where a
 *  relative import LANDS cannot drift from the guard's. It had its own copy of this walk and its own
 *  regex for finding the specifiers, which is the second copy the module header warns about — a guard
 *  that reads imports differently from the tool that rewrites them is how a mispair gets waved through. */
const resolveRel = (fromDir, rel) => aliasForDir(fromDir, rel).slice(2);

/** Is this normalized path something `@/…` can reach — a module still in `src/`, one being emitted, or
 *  a colocated ASSET the test reads as data?
 *
 *  The asset arm is why `ecbd2402` could not carry `projectPaths`: "a test importing a COLOCATED
 *  NON-MODULE ASSET cannot move, because the asset does not". `./projectSlug.fixtures.json` names an
 *  exact file, and appending `.ts` to it asks for something nobody wrote — so the specifier resolved to
 *  nothing, the carried test was declined as unresolvable, and the record could never hold it.
 *
 *  The asset does not have to move. It stays under `src/` and the rewrite sends the emitted copy at it
 *  through the same `@/…` alias the module specifiers already use, so exactly ONE copy of the fixture
 *  exists — still at the path the Rust `find_fixture` name search walks (`mobile/tunnel/mod.rs` panics on
 *  a second name match under `src/`). `.bsc-records/` is not under `src/`, and nothing here writes a
 *  fixture into it.
 *
 *  Checked LAST and never INSTEAD. A dotted tail does not prove an extension — `./platformModules.gen`
 *  and `./styleContract.gen` are ordinary modules whose names contain a dot — so sniffing the tail first
 *  would decline the very imports that resolve today. Trying the module extensions first makes this
 *  purely additive: a specifier that resolved before still resolves, by the same arm. */
function reachable(relPath, willEmit) {
  if (willEmit.has(relPath)) return true;
  const base = join(REPO, "src", ...relPath.split("/"));
  if ([".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts"].some((e) => existsSync(base + e))) return true;
  return existsSync(base);
}

/** Rewrite a carried test's RELATIVE imports to absolute `@/…` specifiers.
 *
 *  A carried test was harvested beside its module, so it says `./LabelChip`. Emitted into
 *  `.bsc-records/`, that resolves only if `LabelChip` is ALSO a record — and a sibling that is still an
 *  ordinary file under `src/` is unreachable from there, because nothing bridges the two trees
 *  relatively. `@/shared/ui/data/LabelChip` reaches both: the alias finds `src/` first and the record
 *  fallback answers when the file is gone. It is the same rewrite `retire-module.mjs` performs on the
 *  colocated copy, for the same reason, so both copies of a test resolve identically.
 *
 *  Without this, retiring a test file worked only when every sibling it touched was already a record —
 *  `@/shared/ui/data/Avatar` was exactly that case and would have gone dark on a green gate. */
function rewriteRelativeImports(src, dir) {
  let out = src;
  // Back to front, so an earlier splice cannot shift a later index.
  for (const { spec, at } of relativeSpecifiers(src).reverse()) {
    out = out.slice(0, at) + aliasForDir(dir, spec) + out.slice(at + spec.length);
  }
  return out;
}

/**
 * Where an edge test is emitted, as a `.bsc-records/`-relative path. PURE, and exported so the guard can
 * exercise the rule with no edges in the seed — otherwise "every edge is handled" passes by there being
 * none, which is the vacuous green this repo keeps getting caught by.
 *
 * The address is the edge's PROVENANCE (`src`), mirrored. An edge spans several records and so has no
 * home specifier to sit beside, and the alternative — one synthetic folder — would silently re-classify
 * every pure-domain integration test: the vitest `node` project selects on a path containing `/lib/`,
 * and losing that costs 488.56s of DOM construction against 13.93s of tests on this subset.
 *
 * `i` disambiguates an edge carrying more than one test file, exactly as the node path does.
 */
export function edgeTestPath(from, i, ext, code) {
  const relBase = from.replace(/^src\//, "").replace(/\.(test|spec)\.tsx?$/, "");
  const suffix = i === 0 ? "" : `.${i}`;
  const chosen = typeof ext === "string" && /^\.[jt]sx?$/.test(ext) ? ext : extFor(code ?? "");
  return relBase + suffix + ".test" + chosen;
}

/** Write `content` at `path` only when the bytes already there differ. Returns whether it wrote.
 *
 *  THE POINT IS THE MTIME, NOT THE I/O. `.bsc-records/` sits inside the dev server's watched root, so a
 *  blind rewrite of all ~1,350 files is a change storm at whatever vite has the tree open — which is
 *  exactly what made a mid-session re-emit look unaffordable and left the self-heal gated behind a
 *  resolve MISS, blind to an EDIT of a record already in the tree
 *  (`an-edited-record-never-reaches-the-running-dev-server`). Writing only what changed makes an emit
 *  that changed one record touch one file, so HMR updates that module and nothing else — and it also
 *  stops every `npm run typecheck` in this checkout from re-stamping the whole tree under a running app.
 *
 *  Compares CONTENT, never mtimes. The seed is the source of truth and the emitted copy is derived, so
 *  "same bytes" is the whole question; an mtime comparison would rewrite on every `git checkout` that
 *  touched a seed without changing it. */
export function writeIfChanged(path, content) {
  try {
    if (readFileSync(path, "utf8") === content) return false;
  } catch {
    /* absent, or unreadable ⇒ write it */
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return true;
}

/** Every file under `dir` that `intended` does not name.
 *
 *  This is what deleting the whole tree was really for: a module that came BACK to `src/` leaves an
 *  emitted copy which shadows nothing (src wins) but is dead weight the next reader has to explain, and
 *  a retired module's carried test would keep RUNNING. Returned rather than deleted so the decision can
 *  be tested without a filesystem to destroy. */
export function staleEmitted(dir, intended) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!intended.has(p)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** Remove directories left empty by a prune, depth first. Returns whether `dir` itself ended up empty —
 *  `dir` is never removed, so calling it on the tree root cannot delete the root. */
function pruneEmptyDirs(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  let remaining = 0;
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory() && pruneEmptyDirs(p)) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        remaining++;
      }
    } else remaining++;
  }
  return remaining === 0;
}

/** DECIDE what to emit, writing nothing.
 *
 *  Split from the writing half so a guard can ask "would this record's test actually run?" without
 *  triggering an emit. `emitRecords` also PRUNES what it no longer intends, so a test that called it mid
 *  suite would delete files out from under every other file being collected in parallel — the same race
 *  `vite/bscRecords.ts` documents for the worker sub-build. (It no longer deletes the tree WHOLESALE
 *  first — see `writeIfChanged` — but the prune alone is still enough to lose that race.)
 *
 *  ⚠️ A CARRIED TEST IS NOT NECESSARILY THIS RECORD'S TEST. `bsc ui harvest` attached whatever colocated
 *  `*.test.*` it found, so the seed holds records paired with a test for something else entirely —
 *  `@/components/typechip` carries the test for `ScanViews`, and four separate records all carry the one
 *  `bodyStyles` test. Emitting those verbatim puts a broken import into the gate: measured, 15 of the
 *  first 21 emitted failed to resolve, all of them mispairs. (`harvest-pairs-only-an-isolated-test` fixed
 *  the harvester; it did not clean the records the old one had already written.)
 *
 *  So the pairing is VERIFIED rather than trusted: every relative import the test makes must land on a
 *  module this same plan is emitting. Checking against the PLAN rather than the filesystem keeps it pure
 *  and order-independent — a test may name a record that would be written later in the run. `@/…` imports
 *  are not checked; they go through the alias and the record fallback, exactly as the module's own do. */
export function planRecords() {
  const seeds = collectSeeds();
  const modules = [];
  for (const [spec, rec] of seeds) {
    if (fileExists(spec)) continue; // the file is still there and authoritative
    modules.push({ spec, rec, rel: spec.slice(2) });
  }
  const willEmit = new Set(modules.map((m) => m.rel));

  const tests = [];
  const shadowed = [];
  const unresolvable = [];
  for (const { spec, rec, rel } of modules) {
    if (!rec.tests.length) continue;
    if (testFileExists(spec)) {
      // `src/` still runs this test — do not plan a second, duplicate copy of the same assertions.
      shadowed.push(spec);
      continue;
    }
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    rec.tests.forEach((t, i) => {
      const src = typeof t?.src === "string" ? t.src : "";
      if (!src.trim()) return;
      const name = t?.name ?? "(unnamed)";
      const missing = relativeSpecifiers(src)
        .map((s) => s.spec)
        .filter((r, idx, all) => all.indexOf(r) === idx)
        .filter((r) => !reachable(resolveRel(dir, r), willEmit));
      if (missing.length) {
        unresolvable.push({ spec, name, missing, detail: `${spec} → ${name} — cannot resolve ${missing.join(", ")}` });
        return;
      }
      // One entry per FILE (#3907), so >1 entry means the record carried more than one test file. Keep
      // them distinct rather than letting the second silently overwrite the first.
      const suffix = i === 0 ? "" : `.${i}`;
      tests.push({
        spec,
        name,
        ext: typeof t?.ext === "string" && /^\.[jt]sx?$/.test(t.ext) ? t.ext : undefined,
        src: rewriteRelativeImports(src, dir),
        // The CARRIED extension wins over the guess. `extFor` reads `<T>(a: readonly T[])` — an
        // ordinary TypeScript generic, and test files are full of them — as a JSX tag, names the file
        // `.tsx`, and the parser then fails on it: "Unexpected token. Did you mean `{'>'}`?". Measured
        // at 177 of 376 algorithm-subject tests, so the guess is wrong about HALF the time on this
        // corpus. A record that knows its source extension states it; `extFor` stays the fallback for
        // the records that predate the field, whose behaviour is unchanged.
        rel: rel + suffix + ".test" + (typeof t?.ext === "string" && /^\.[jt]sx?$/.test(t.ext) ? t.ext : extFor(src)),
        detail: `${spec} → ${name}`,
      });
    });
  }
  // ── EDGE tests (integration-tests-become-graph-edges) ────────────────────────────────────────────
  //
  // An edge test spans SEVERAL records, so unlike a node test it has no home specifier to be emitted
  // beside. Its address is its PROVENANCE — `edge.src`, the root-relative path of the file it was lifted
  // from — mirrored into `.bsc-records/`.
  //
  // That is not merely tidy. The vitest `node` project selects on a path containing `/lib/`, so parking
  // every edge test under one synthetic folder would hand each pure-domain integration test a jsdom it
  // was written not to need — 488.56s of environment against 13.93s of tests, measured on that subset.
  // Mirroring the source path keeps the classification the author already made.
  const edgeTests = [];
  const edgeShadowed = [];
  const edgeUnresolvable = [];
  for (const e of collectEdges()) {
    const id = typeof e?.id === "string" ? e.id.trim() : "";
    const list = Array.isArray(e?.tests) ? e.tests : [];
    if (!id || !list.length) continue;
    const from = typeof e?.src === "string" ? e.src.trim() : "";
    // Provenance is REQUIRED to emit, not optional. Without it there is no honest path to write to, and
    // guessing one is how a lib/ test loses its environment. Declined loudly rather than parked anywhere.
    if (!from.startsWith("src/")) {
      edgeUnresolvable.push({ id, detail: `${id} — no \`src\` provenance, so there is no path to emit it at` });
      continue;
    }
    // The file still exists ⇒ IT is the copy that runs, exactly as for a node test. Emitting as well
    // would run the same assertions twice, which is the one thing this tier must never do.
    if (existsSync(join(REPO, ...from.split("/")))) {
      edgeShadowed.push(id);
      continue;
    }
    const relBase = from.slice("src/".length).replace(/\.(test|spec)\.tsx?$/, "");
    const dir = relBase.includes("/") ? relBase.slice(0, relBase.lastIndexOf("/")) : "";
    list.forEach((t, i) => {
      const src = typeof t?.src === "string" ? t.src : "";
      if (!src.trim()) return;
      const missing = relativeSpecifiers(src)
        .map((r) => r.spec)
        .filter((r, idx, all) => all.indexOf(r) === idx)
        .filter((r) => !reachable(resolveRel(dir, r), willEmit));
      if (missing.length) {
        edgeUnresolvable.push({ id, detail: `${id} — cannot resolve ${missing.join(", ")}` });
        return;
      }
      edgeTests.push({
        id,
        members: Array.isArray(e.members) ? e.members : [],
        src: rewriteRelativeImports(src, dir),
        rel: edgeTestPath(from, i, t?.ext, src),
        detail: `${id} [${(Array.isArray(e.members) ? e.members : []).join(" × ")}]`,
      });
    });
  }

  return { modules, tests, shadowed, unresolvable, edgeTests, edgeShadowed, edgeUnresolvable };
}

export function emitRecords({ quiet = false } = {}) {
  const { modules, tests, shadowed, unresolvable, edgeTests, edgeShadowed, edgeUnresolvable } = planRecords();
  // PLAN THE WHOLE TREE FIRST, then reconcile the disk to it. This used to `rmSync` the tree and rewrite
  // every file, which is a change storm at any dev server watching `.bsc-records/` — and that cost is why
  // the mid-session re-emit in `vite/bscRecords.ts` was gated behind a resolve MISS, and so could never
  // see an EDIT to a record already in the tree. Reconciling instead (prune what is no longer intended,
  // write only what actually differs) makes a re-emit cheap enough to run on a timer, so an edited record
  // reaches a running app. Same end state as the delete-and-rebuild, minus the churn.
  const files = new Map();

  const emitted = [];
  for (const { spec, rec, rel } of modules) {
    const path = join(OUT, ...rel.split("/")) + extFor(rec.code);
    files.set(
      path,
      `// GENERATED from the packaged seed for \`${rec.id}\` — do not edit, and do not commit.\n` +
        `// The record is the source of truth; this file is a derived cache so tsc/vite/vitest can resolve\n` +
        `// \`${spec}\` after the original module was retired. Regenerate with \`npm run emit:records\`.\n` +
        rec.code,
    );
    emitted.push(spec);
  }

  // The records' TESTS, beside the module each one tests. This is what keeps a retired module's coverage
  // inside the default gate: `npm test` runs this script and THEN `vitest run`, and `vitest.config.ts`
  // includes `.bsc-records/**`, so a carried test executes against the record that actually ships. Without
  // it, deleting a colocated test trades executed coverage for stored coverage behind a green gate —
  // exactly what cost 31 assertions before `retiredTests.test.ts` existed.
  //
  // The mirrored layout is also what lets a carried test keep its VERBATIM relative import: `./Button`
  // from `.bsc-records/shared/ui/controls/Button.test.tsx` resolves to the emitted `Button.tsx` next to it.
  const emittedTests = [];
  for (const t of tests) {
    const tPath = join(OUT, ...t.rel.split("/"));
    files.set(
      tPath,
      `// GENERATED from the packaged seed's carried test for \`${t.spec}\` — do not edit, do not commit.\n` +
        `// It runs in the default gate against the emitted record, not against a file under \`src/\`.\n` +
        t.src,
    );
    emittedTests.push(t.detail);
  }

  // The EDGE tests, at the mirror of the file each was lifted from. Same writer as the node tests, and
  // deliberately so: an edge test that ran differently from a record test would be a second execution
  // model to keep in agreement with the first.
  const emittedEdges = [];
  for (const t of edgeTests) {
    const tPath = join(OUT, ...t.rel.split("/"));
    files.set(
      tPath,
      `// GENERATED from the packaged seed's EDGE test \`${t.id}\` — do not edit, do not commit.\n` +
        `// It verifies the RELATIONSHIP between ${t.members.length || "several"} records` +
        `${t.members.length ? ` (${t.members.join(" × ")})` : ""}, which is why it lives on the edge\n` +
        `// rather than being forced onto one node that does not own it.\n` +
        t.src,
    );
    emittedEdges.push(t.detail);
  }
  const shadowedTests = shadowed;
  const unresolvableTests = unresolvable.map((u) => u.detail);

  files.set(join(OUT, ".gitignore"), "*\n"); // the tree ignores itself, wherever it is checked out

  // RECONCILE: prune first so a rename frees its old path, then write only the bytes that differ, then
  // drop the directories the prune emptied.
  mkdirSync(OUT, { recursive: true });
  const pruned = staleEmitted(OUT, files);
  for (const p of pruned) rmSync(p, { force: true });
  let changed = 0;
  for (const [path, content] of files) if (writeIfChanged(path, content)) changed++;
  pruneEmptyDirs(OUT);
  if (!quiet) {
    console.log(`emit-records: ${emitted.length} retired specifier(s) materialized from seeds`);
    for (const s of emitted.sort()) console.log("   " + s);
    console.log(`emit-records: ${emittedTests.length} carried test file(s) materialized`);
    for (const s of emittedTests.sort()) console.log("   " + s);
    // NEVER silent, in either direction. "This module has no test", "its test is shadowed by a file" and
    // "its test is mispaired and cannot run" are three different states that look identical from outside.
    if (shadowedTests.length) {
      console.log(
        `emit-records: ${shadowedTests.length} record(s) carry tests that a colocated src/ file still shadows`,
      );
      for (const s of shadowedTests.sort()) console.log("   " + s);
    }
    if (unresolvableTests.length) {
      console.log(`emit-records: ${unresolvableTests.length} carried test(s) NOT emitted — unresolvable`);
      for (const s of unresolvableTests.sort()) console.log("   " + s);
    }
    // The edge tier reports in the SAME three states, and reports 0 rather than staying silent: an
    // unpopulated tier and a broken one look identical from outside, and this one shipped unpopulated.
    console.log(`emit-records: ${emittedEdges.length} EDGE test file(s) materialized`);
    for (const s of emittedEdges.sort()) console.log("   " + s);
    if (edgeShadowed.length) {
      console.log(`emit-records: ${edgeShadowed.length} edge(s) carry tests a src/ file still shadows`);
      for (const s of [...edgeShadowed].sort()) console.log("   " + s);
    }
    if (edgeUnresolvable.length) {
      console.log(`emit-records: ${edgeUnresolvable.length} edge test(s) NOT emitted — unresolvable`);
      for (const u of edgeUnresolvable.map((u) => u.detail).sort()) console.log("   " + u);
    }
    // What the reconcile actually DID, which is the number that says whether an emit was a no-op. A run
    // reporting `0 file(s) written` against a non-zero materialized count is the healthy steady state,
    // not a failure — the tree already agreed with the seeds.
    console.log(`emit-records: ${changed} file(s) written, ${pruned.length} pruned (${files.size} intended)`);
  }
  // `emitted` for every existing caller; the reconcile counts hang off it so a caller that wants to know
  // whether anything MOVED — the dev-server watcher does — can ask without a second walk of the tree.
  emitted.changed = changed;
  emitted.pruned = pruned.length;
  return emitted;
}

// Still a CLI: `tsc` does not run through vite, so `npm run typecheck` needs a way to materialize the
// tree before type resolution. Everything that DOES go through vite is served by the plugin instead.
if (process.argv[1] && process.argv[1].endsWith("emit-records.mjs")) emitRecords();
