// The retirement census — which files can go, and which would take a feature with them.
//
// A file is retirable when a packaged seed `provides` its specifier with real source, because
// `emit-records.mjs` then materializes that seed into `.bsc-records/` the moment the file is gone and all
// four resolvers (tsc via `tsconfig.paths`, vite + vitest via `vite/bscRecords.ts`, and the e2e config)
// find it there. That much is mechanical.
//
// WHAT IS NOT MECHANICAL, and is the whole reason this script exists: the seed's `srcText` is a
// PROJECTION of the file taken at migration time, and the two drift. Retiring a file whose seed has
// fallen behind does not "move" the module — it REPLACES it with an older copy, silently, and the gate
// stays green because the older copy still compiles. So every candidate is classified by whether its seed
// still agrees with the file, and only `same` is safe to retire without first refreshing the seed.
//
// The comparison skips the seed's "AS GRAPH SOURCE" preamble, which the file never had. The preamble ends
// at the first line the file also contains — the same rule the migration used to add it.
//
// ⚠️ RETIRE THE MODULE, KEEP ITS TEST. A `[+test]` below is not a thing to delete alongside the file. The
// record carries the test as data, but nothing in the default gate RUNS carried tests, so deleting the
// colocated file trades executed coverage for stored coverage with a green gate — it cost 31 assertions
// before anyone noticed. Rewrite the test's relative import to `@/…` and leave it: it then resolves to the
// emitted record and the gate verifies the module that actually ships. `retiredTests.test.ts` enforces it.
//
//   node scripts/retirement-candidates.mjs            # the summary + the retirable list
//   node scripts/retirement-candidates.mjs --all      # ...including the drifted ones, with byte deltas
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { norm, codeOnly, splitPreamble, exportedNames, fileAsRecordSource, entriesImportingStatically } from "./lib/recordSource.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOW_ALL = process.argv.includes("--all");

/** Every file under `src/`, as repo-relative paths. Built from a real directory listing, never
 *  `existsSync` — that is case-INSENSITIVE on Windows, so a case-mismatched path passes the very check
 *  meant to catch it. */
function listSrc() {
  const out = new Set();
  (function walk(dir, rel) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), r);
      else out.add(r);
    }
  })(join(REPO, "src"), "");
  return out;
}

const EXT = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"];
const fileFor = (srcFiles, spec) => {
  const b = spec.slice(2);
  for (const e of EXT) if (srcFiles.has(b + e)) return b + e;
  return null;
};

/** Every packaged seed that provides a `@/…` specifier with real source, keyed by specifier. Components
 *  win a collision with an algorithm impl — the same precedence `resolveGraphSource` and `emit-records`
 *  apply, so this report describes what would actually be served. */
function collectSeeds() {
  const seeds = new Map();
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith(".json") || statSync(p).size > 4_000_000) continue;
      let r;
      try { r = JSON.parse(readFileSync(p, "utf8")); } catch { continue; }
      const spec = typeof r?.provides === "string" ? r.provides.trim() : "";
      if (spec.startsWith("@/") && typeof r.srcText === "string" && r.srcText.trim() && r.id)
        seeds.set(spec, { id: r.id, kind: "component", source: r.srcText });
    }
  })(join(REPO, "src-tauri", "data", "components"));
  try {
    const k = JSON.parse(readFileSync(join(REPO, "src-tauri/data/knowledge/algorithms.json"), "utf8"));
    for (const im of k?.implementations ?? []) {
      const spec = typeof im?.provides === "string" ? im.provides.trim() : "";
      if (spec.startsWith("@/") && typeof im.code === "string" && im.code.trim() && im.id && !seeds.has(spec))
        seeds.set(spec, { id: im.id, kind: "algorithm", source: im.code });
    }
  } catch { /* a checkout without the algorithm seed is still valid */ }
  return seeds;
}

/** The identifiers a source DECLARES, split by whether they are exported — the comparison that survives
 *  reformatting. Comparing bytes calls a reflowed comment "drift"; comparing SYMBOLS asks the question
 *  that matters, which is whether retiring the file would take an export or a helper with it.
 *
 *  The export/internal split is the severity: a missing EXPORT breaks importers at once (retiring
 *  `SettingsPageHeader.tsx` against its current seed would delete `SettingsSubHeader`, which three other
 *  files render), while a missing internal name means the seed is merely an older revision — still drift,
 *  still a reason to refresh the seed first, but not an immediate break. */
function symbols(src) {
  // Imports stripped first, or `import { type Foo }` reads as a `type Foo` DECLARATION and three deploy
  // modules get reported as drifted when they are not. A false "drifted" costs as much as a missed one.
  const body = src.replace(/^[ \t]*import\s+[^;]*?from\s*["'][^"']+["'];?[ \t]*$/gm, "");
  const all = new Set(), exported = new Set();
  const re = /(?:^|\n)[ \t]*(export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const m of body.matchAll(re)) {
    all.add(m[2]);
    if (m[1]) exported.add(m[2]);
  }
  return { all, exported };
}

const srcFiles = listSrc();
const seeds = collectSeeds();
const texts = new Map();
for (const f of srcFiles) if (/\.(ts|tsx)$/.test(f)) texts.set(f, readFileSync(join(REPO, "src", f), "utf8"));

/** Files importing `spec` — by the `@/` specifier OR by a RELATIVE path that resolves to the same module.
 *  The relative half is the one that matters: a resolver hook matching `@/…` never sees `./Spacer`, and
 *  a test file counts as an importer, so a module whose test remains would leave a test importing nothing. */
function importersOf(spec, file) {
  const base = file.replace(/\.(tsx?|jsx?)$/, "").replace(/\/index$/, "");
  const byAlias = [], byRelative = [];
  for (const [f, t] of texts) {
    if (f === file) continue;
    if (t.includes(spec)) { byAlias.push(f); continue; }
    const fdir = f.replace(/\/[^/]+$/, "");
    for (const m of t.matchAll(/(?:from|import|require)\s*\(?\s*["'](\.\.?\/[^"']+)["']/g)) {
      const out = [];
      for (const p of (fdir + "/" + m[1]).split("/")) {
        if (p === "." || p === "") continue;
        if (p === "..") out.pop();
        else out.push(p);
      }
      if (out.join("/") === base) { byRelative.push(f); break; }
    }
  }
  return { byAlias, byRelative };
}

const rows = [];
for (const [spec, seed] of seeds) {
  const file = fileFor(srcFiles, spec);
  if (!file) continue; // already retired, or record-native — not a candidate, and not a defect
  // NEVER RETIRABLE: the algorithms SEED modules exist precisely to BE files. Their whole point
  // (`seedAlgorithms.gen.test.ts`, #3465) is that a packaged node's `code` is generated FROM a real
  // module — so tsc checks it, its sibling test executes it, and the standalone guarantee is enforced
  // rather than claimed. Retiring one turns that generator back into a claim, which is the state it was
  // built to end. `llmEnergy.ts` went in a tranche before this guard existed.
  if (/^shared\/lib\/algorithms\/[^/]+\.ts$/.test(file)) continue;
  // NEVER RETIRABLE: `.d.ts` is AMBIENT TYPE INFORMATION, not a module. tsc reads it because it is
  // INCLUDED, never because something imports it, so no resolver substitutes a record for it and no
  // record carries its meaning. `src/vite-env.d.ts` went once — the whole typecheck then failed on
  // `*.css` and `*?raw` side-effect imports, since the file declaring those wildcards was gone.
  if (/\.d\.ts$/.test(file)) continue;
  // NEVER RETIRABLE: a module an app ENTRY imports STATICALLY. The dev server's pre-transform pass
  // resolves the `@/…` alias to `/src/…` before the records plugin is installed, so the module has to
  // exist as a file however good its record is — retiring one makes the app fail to boot while tsc,
  // lint, vitest and `vite build` all stay green.
  //
  // This census had no such rule and the tool that DELETES did, so the two disagreed: four candidates
  // were offered here — `useAppBoot`, `ConsoleGraphHost`, `TerminalHost`, `features/sounds/index` — and
  // `retire-module` refused every one of them. Shared definition now, for the reason this file's own
  // header gives: a census that grades differently from the tool that acts is worse than either being
  // wrong alone.
  if (entriesImportingStatically(REPO, file.replace(/\.(tsx?|jsx?)$/, "").replace(/\/index$/, ""),
    (p) => readFileSync(p, "utf8"), (p) => existsSync(p)).length) continue;
  // As a RECORD would hold it: LF-normalized with relative imports absolutized. Comparing the raw file
  // graded 21 candidates "body differs" purely on import FORM — the migration absolutized by hand.
  const fileSrc = fileAsRecordSource(join(REPO, "src", file), file);
  const seedSrc = splitPreamble(norm(seed.source), fileSrc)[1];
  const fileSyms = symbols(fileSrc), seedSyms = symbols(seedSrc);
  const missing = [...fileSyms.all].filter((s) => !seedSyms.all.has(s));
  const missingExports = missing.filter((s) => fileSyms.exported.has(s));
  const { byAlias, byRelative } = importersOf(spec, file);
  const base = file.replace(/\.(tsx?|jsx?)$/, "");
  const test = ["test", "spec"].flatMap((k) => [`${base}.${k}.ts`, `${base}.${k}.tsx`]).find((p) => srcFiles.has(p));
  rows.push({
    spec, file, id: seed.id, kind: seed.kind, test,
    importers: byAlias.length + byRelative.length,
    relative: byRelative,
    // The ladder, strictest first. Only the top two are safe to retire without reading the diff:
    //   same        — byte-identical once the preamble is off.
    //   reformatted — identical CODE; only comments and whitespace differ.
    //   BODY-DIFFERS— the code itself differs. Retiring ships the record's behaviour, not the file's, and
    //                 it compiles either way. `connectorForm` is here and would have lost a prop.
    //   BREAKS      — worse still: the record is missing an EXPORT other modules import.
    verdict:
      seedSrc === fileSrc ? "same"
      : missingExports.length ? "BREAKS"
      : codeOnly(seedSrc) === codeOnly(fileSrc) ? "reformatted"
      : "BODY-DIFFERS",
    missing, missingExports,
    delta: seedSrc.length - fileSrc.length,
  });
}
rows.sort((a, b) => a.importers - b.importers || a.file.localeCompare(b.file));

const by = (v) => rows.filter((r) => r.verdict === v);
console.log(`retirement candidates (a seed provides it, the file is still present): ${rows.length}`);
console.log(`  RETIRABLE   ${String(by("same").length + by("reformatted").length).padStart(3)}`);
console.log(`    same          ${String(by("same").length).padStart(3)}  — byte-identical to the file once the preamble is off`);
console.log(`    reformatted   ${String(by("reformatted").length).padStart(3)}  — identical CODE; only comments and whitespace differ`);
console.log(`  NOT RETIRABLE ${String(by("BODY-DIFFERS").length + by("BREAKS").length).padStart(3)}  — refresh the seed from the file first`);
console.log(`    BODY-DIFFERS  ${String(by("BODY-DIFFERS").length).padStart(3)}  — the record's CODE differs; retiring ships ITS behaviour, and it compiles`);
console.log(`    BREAKS        ${String(by("BREAKS").length).padStart(3)}  — the record is missing an EXPORT other modules import`);
console.log(`  with a colocated test:        ${rows.filter((r) => r.test).length}`);
console.log(`  with RELATIVE importers:      ${rows.filter((r) => r.relative.length).length}  (each must be rewritten to @/ first)`);
console.log("");
const unsafe = (r) => r.verdict === "BREAKS" || r.verdict === "BODY-DIFFERS";
console.log("verdict       imp rel  file");
for (const r of rows) {
  if (!SHOW_ALL && unsafe(r)) continue;
  const lost = r.missingExports.length ? `  missing export: ${r.missingExports.slice(0, 4).join(", ")}` : "";
  console.log(
    r.verdict.padEnd(13),
    String(r.importers).padStart(3),
    String(r.relative.length).padStart(3),
    ` ${r.file}${r.test ? "  [+test]" : ""}${unsafe(r) ? lost || `  (${r.delta > 0 ? "+" : ""}${r.delta} chars)` : ""}`,
  );
}
if (!SHOW_ALL && rows.some(unsafe))
  console.log(`\n(${rows.filter(unsafe).length} NOT-retirable candidate(s) hidden — \`--all\` to see them)`);
