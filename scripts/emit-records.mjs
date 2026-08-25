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

/** Is this normalized path something `@/…` can reach — a module still in `src/`, or one being emitted? */
function reachable(relPath, willEmit) {
  if (willEmit.has(relPath)) return true;
  const base = join(REPO, "src", ...relPath.split("/"));
  return [".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts"].some((e) => existsSync(base + e));
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

/** DECIDE what to emit, writing nothing.
 *
 *  Split from the writing half so a guard can ask "would this record's test actually run?" without
 *  triggering an emit. `emitRecords` starts by `rmSync`-ing the whole tree, so a test that called it mid
 *  suite would delete `.bsc-records/` out from under every other file being collected in parallel — the
 *  same race `vite/bscRecords.ts` documents for the worker sub-build.
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
  return { modules, tests, shadowed, unresolvable };
}

export function emitRecords({ quiet = false } = {}) {
  const { modules, tests, shadowed, unresolvable } = planRecords();
  // A full rebuild each run: a stale emitted file for a module that came BACK would shadow nothing (src
  // wins) but would still be dead weight the next reader has to explain.
  rmSync(OUT, { recursive: true, force: true });

  const emitted = [];
  for (const { spec, rec, rel } of modules) {
    const path = join(OUT, ...rel.split("/")) + extFor(rec.code);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `// GENERATED from the packaged seed for \`${rec.id}\` — do not edit, and do not commit.\n` +
        `// The record is the source of truth; this file is a derived cache so tsc/vite/vitest can resolve\n` +
        `// \`${spec}\` after the original module was retired. Regenerate with \`npm run emit:records\`.\n` +
        rec.code,
      "utf8",
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
    mkdirSync(dirname(tPath), { recursive: true });
    writeFileSync(
      tPath,
      `// GENERATED from the packaged seed's carried test for \`${t.spec}\` — do not edit, do not commit.\n` +
        `// It runs in the default gate against the emitted record, not against a file under \`src/\`.\n` +
        t.src,
      "utf8",
    );
    emittedTests.push(t.detail);
  }
  const shadowedTests = shadowed;
  const unresolvableTests = unresolvable.map((u) => u.detail);

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, ".gitignore"), "*\n", "utf8"); // the tree ignores itself, wherever it is checked out
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
  }
  return emitted;
}

// Still a CLI: `tsc` does not run through vite, so `npm run typecheck` needs a way to materialize the
// tree before type resolution. Everything that DOES go through vite is served by the plugin instead.
if (process.argv[1] && process.argv[1].endsWith("emit-records.mjs")) emitRecords();
