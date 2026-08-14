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
//   node scripts/retirement-candidates.mjs            # the summary + the retirable list
//   node scripts/retirement-candidates.mjs --all      # ...including the drifted ones, with byte deltas
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const norm = (s) => s.replace(/\r\n/g, "\n").trimEnd();

/** Drop the seed's "AS GRAPH SOURCE" preamble: everything before the first line the FILE also contains.
 *  Bounded to the head of the source so a coincidental match deep in a long module cannot eat real code. */
function stripPreamble(seedSrc, fileSrc) {
  const lines = seedSrc.split("\n");
  const fileLines = new Set(fileSrc.split("\n").map((l) => l.trim()).filter((l) => l.length > 8));
  for (let i = 0; i < Math.min(lines.length, 60); i++) {
    const t = lines[i].trim();
    if (t.length > 8 && fileLines.has(t)) return lines.slice(i).join("\n");
  }
  return seedSrc;
}

/** Source with its import statements removed. Load-bearing for {@link symbols}: `import { type Foo }`
 *  otherwise reads as a `type Foo` DECLARATION, and three deploy modules were reported as drifted purely
 *  because their seed formats that import differently. A false "drifted" costs as much as a missed one —
 *  it blocks a retirement that was safe, and the next reader has no way to tell the two apart. */
const withoutImports = (src) =>
  src.replace(/^\s*import\s[\s\S]*?from\s*["'][^"']+["'];?[ \t]*$/gm, "").replace(/^\s*import\s+["'][^"']+["'];?[ \t]*$/gm, "");

/** Source reduced to its CODE: comments gone, whitespace collapsed. Two sources equal under this differ
 *  only in formatting and prose, which is exactly what a migration's transcription is allowed to change.
 *
 *  This is the bar, and symbol equality is NOT. `connectorForm.tsx` proved it: its record declares every
 *  symbol the file does and is a PREVIEW-GRADE transcription — `SourceCard` destructures `runtime` and
 *  then never uses it, where the file passes it to `connector(src.connectorId, runtime)`. Retiring that
 *  file would have shipped a card that silently resolves the wrong connector identity, and only tsc's
 *  unused-local check happened to notice. A body that quietly does less is precisely the failure a
 *  symbol-level comparison cannot see, and it is the one that costs a feature.
 *
 *  String literals are left alone: a changed string is a changed behaviour (a label, a key, a class name),
 *  not formatting. */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/\s+/g, " ")
    .trim();
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
  const body = withoutImports(src);
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
  const fileSrc = norm(readFileSync(join(REPO, "src", file), "utf8"));
  const seedSrc = norm(stripPreamble(norm(seed.source), fileSrc));
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
