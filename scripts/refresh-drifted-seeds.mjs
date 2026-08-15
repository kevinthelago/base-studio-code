// Refresh a packaged seed's `srcText` from the file it mirrors — the step that turns a drifted
// retirement candidate into a retirable one.
//
// WHY IT IS SAFE ONLY FOR SOME. A seed's `srcText` is a projection of the file taken at migration time,
// and the two drift. Refreshing FROM the file is correct exactly when the record has no independent
// history worth keeping — and the three-way (seed vs STORE vs file) is what says so:
//
//   store == seed   the record has NEVER been edited since packaging, so the drift is entirely the file
//                   moving on. Refreshing loses nothing.  ← the only case this script touches
//   store != seed   a designer edited the record. Refreshing from the file would DISCARD that edit, and
//                   deciding whether it was a deliberate improvement is a judgement, not a script's call.
//
// It refuses the second case rather than asking. Four records are there today and are named in the plan
// item; a script that guessed would be the second unrecoverable write this whole session is about.
//
// THE PREAMBLE SURVIVES. Every migrated record opens with an "AS GRAPH SOURCE" comment block the file
// never had, recording why the record exists and what `provides` does. Overwriting `srcText` with the raw
// file deletes it — that happened before, and four records SHRANK while their change only added
// attributes. The preamble ends at the first line the file also contains, which is the same rule the
// migration used to add it; that prefix is preserved verbatim and the file's content is appended.
//
// Only the SEED is written. For a pristine builtin, `reconcileSeed` pushes the refreshed seed into the
// store at the next hydrate (`!modified && seedMoved` → adopt the seed copy), so writing the store here
// would be a second, racier path to the same place.
//
//   node scripts/refresh-drifted-seeds.mjs --store <bsc-ui-list--full.json> [--apply] [--only <path>]
//
// `--store` is a `bsc ui list --full` dump; without `--apply` it reports and writes nothing.
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { norm, codeOnly, splitPreamble, exportedNames, fileAsRecordSource } from "./lib/recordSource.mjs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const storeArg = argv[argv.indexOf("--store") + 1];
const implsArg = argv.includes("--impls") ? argv[argv.indexOf("--impls") + 1] : null;
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
if (!argv.includes("--store") || !storeArg) {
  console.error("usage: node scripts/refresh-drifted-seeds.mjs --store <bsc ui list --full dump> [--impls <bsc graph impl list dump>] [--apply] [--only <src-path>]");
  process.exit(2);
}
// The COMPONENT store, keyed by id — the "has a designer edited this record" gate.
const store = new Map(JSON.parse(readFileSync(storeArg, "utf8")).map((r) => [r.id, r]));
// ...and the ALGORITHM store, for the same gate applied to impls. Optional so the script still runs
// without a live algorithms store, in which case impls are simply not considered rather than refreshed
// blind — an absent store must never read as "nobody edited it".
const implStore = implsArg
  ? new Map(JSON.parse(readFileSync(implsArg, "utf8")).map((r) => [r.id, r]))
  : null;

const srcFiles = new Set();
(function walk(dir, rel) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(join(dir, e.name), r);
    else srcFiles.add(r);
  }
})(join(REPO, "src"), "");
const EXT = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"];
const fileFor = (spec) => { const b = spec.slice(2); for (const e of EXT) if (srcFiles.has(b + e)) return b + e; return null; };



/** Every `@/…` specifier → the named imports taken from it, and by whom. Built over BOTH the packaged
 *  records and `src/`, because a record importing a record is exactly the consumer a file-only sweep
 *  cannot see. */
function buildImportIndex(seedList) {
  const index = new Map();
  const add = (src, who) => {
    for (const m of src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["'](@\/[^"']+)["']/g)) {
      const set = index.get(m[2]) ?? new Map();
      for (const part of m[1].split(",")) {
        const n = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim();
        if (!n) continue;
        if (!set.has(n)) set.set(n, new Set());
        set.get(n).add(who);
      }
      index.set(m[2], set);
    }
  };
  for (const { rec, source } of seedList) add(source, `record:${rec.id}`);
  for (const f of srcFiles) if (/\.(ts|tsx)$/.test(f)) add(readFileSync(join(REPO, "src", f), "utf8"), f);
  return index;
}

const seeds = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!e.name.endsWith(".json") || statSync(p).size > 4_000_000) continue;
    let r;
    try { r = JSON.parse(readFileSync(p, "utf8")); } catch { continue; }
    const spec = typeof r?.provides === "string" ? r.provides.trim() : "";
    if (spec.startsWith("@/") && typeof r.srcText === "string" && r.srcText.trim() && r.id)
      seeds.push({ kind: "component", path: p, rec: r, spec, source: r.srcText });
  }
})(join(REPO, "src-tauri", "data", "components"));

// ALGORITHM IMPLS ARE SEEDS TOO, and leaving them out is what this script was missing. A module packaged
// as an impl carries its source in `code` rather than `srcText` and lives inside the one `algorithms.json`
// document rather than a file of its own — differences of STORAGE, not of kind. The three gates below
// apply to it unchanged, so the only thing its absence bought was that an impl whose FILE moved on could
// never be refreshed. Three of them arrived at once when a merge carried back `useCoordinator`,
// `coordinationLog` and `previewShims` — each fixed on develop while a branch retired it.
const ALGOS_PATH = join(REPO, "src-tauri/data/knowledge/algorithms.json");
let algorithms = null;
try {
  algorithms = JSON.parse(readFileSync(ALGOS_PATH, "utf8"));
  for (const im of algorithms.implementations ?? []) {
    const spec = typeof im?.provides === "string" ? im.provides.trim() : "";
    if (spec.startsWith("@/") && typeof im.code === "string" && im.code.trim() && im.id)
      seeds.push({ kind: "impl", rec: im, spec, source: im.code });
  }
} catch { /* a checkout without the algorithm seed is still valid */ }

const importIndex = buildImportIndex(seeds);

/** Every `@/…` specifier a RECORD may import: a registered platform module, or a specifier some record
 *  (component or algorithm impl) `provides`. Mirrors what `platformBoundary.test.ts` asserts.
 *
 *  This is the third gate, and it exists because absolutizing is not enough on its own. A FILE may import
 *  a plain sibling — `charts/index.ts` re-exports `./Charts`, `./primitives`, `./telemetry` — and a
 *  sibling is a perfectly good import for a file and an unresolvable one for a record: the loader has
 *  only the registry and the record store to resolve against, and a bare source file is in neither.
 *  Refreshing those three seeds left five records importing specifiers nothing can serve. */
const resolvable = new Set(JSON.parse(readFileSync(join(REPO, "src-tauri/data/ui/platform-modules.json"), "utf8")));
for (const { rec, spec } of seeds) { resolvable.add(spec); resolvable.add(`@/components/${rec.id}`); }
try {
  const k = JSON.parse(readFileSync(join(REPO, "src-tauri/data/knowledge/algorithms.json"), "utf8"));
  for (const im of k?.implementations ?? []) if (typeof im?.provides === "string") resolvable.add(im.provides.trim());
} catch { /* a checkout without the algorithm seed is still valid */ }

let refreshed = 0, skippedEdited = 0, alreadyOk = 0, skippedBreaking = 0, skippedUnresolvable = 0;
const edited = [], breaking = [], unresolvableList = [];
let algorithmsDirty = false;
for (const { kind, path, rec, spec, source } of seeds) {
  const file = fileFor(spec);
  if (!file) continue;                                  // already retired
  if (only && file !== only) continue;
  // The file's source as a RECORD must state its imports absolutely — see `absolutizeImports`. Done
  // before every comparison below, so "does the seed already match the file" asks about the form the
  // record would actually hold rather than the form on disk.
  const fileSrc = fileAsRecordSource(join(REPO, "src", file), file);
  const [preamble, body] = splitPreamble(norm(source), fileSrc);
  if (codeOnly(body) === codeOnly(fileSrc)) { alreadyOk++; continue; }

  // The gate: has a designer edited this record since it was packaged?
  // The SAME gate for both kinds — only WHERE the live copy lives and WHICH field holds its source
  // differ. An impl with no live store available is refused rather than assumed pristine: an absent
  // store must never read as "nobody edited it".
  const live = kind === "impl" ? implStore?.get(rec.id) : store.get(rec.id);
  const liveSrc = kind === "impl" ? live?.code : live?.srcText;
  const storeSrc = norm(typeof liveSrc === "string" ? liveSrc : "");
  if (!live || codeOnly(storeSrc) !== codeOnly(norm(source))) {
    skippedEdited++;
    edited.push(file);
    continue;
  }

  // The second gate: would the file's version DROP an export something actually imports?
  //
  // A record can carry a deliberate standalone adaptation the file never had — `graphcanvas` inlines
  // `export interface GraphViewport` (the file only `import type`s it from `./useGraphViewport`) and
  // `ui-tree` imports the type FROM the record. Refreshing that seed compiles the record fine and breaks
  // its consumer with "does not provide an export named". Nothing else in the loop would have caught it:
  // the record is pristine, so the store gate above passes it straight through.
  const seedEx = exportedNames(norm(source));
  const fileEx = exportedNames(fileSrc);
  if (seedEx && fileEx) {
    const consumers = importIndex.get(spec) ?? new Map();
    const lost = [...seedEx].filter((n) => !fileEx.has(n) && consumers.has(n));
    if (lost.length) {
      skippedBreaking++;
      breaking.push(`${file} — would drop ${lost.join(", ")} (imported by ${[...new Set(lost.flatMap((n) => [...consumers.get(n)]))].slice(0, 3).join(", ")})`);
      continue;
    }
  }

  // The third gate: can a RECORD actually resolve everything this source imports?
  const unresolved = [...new Set([...fileSrc.matchAll(/(?:from|import|require)\s*\(?\s*['"](@\/[^'"]+)['"]/g)].map((m) => m[1]))]
    .filter((s) => !resolvable.has(s) && !/\.(css|svg|png|json)$/.test(s));
  if (unresolved.length) {
    skippedUnresolvable++;
    unresolvableList.push(`${file} — imports ${unresolved.slice(0, 3).join(", ")}, which no record provides and the platform does not register`);
    continue;
  }

  const next = preamble ? `${preamble}\n${fileSrc}\n` : `${fileSrc}\n`;
  refreshed++;
  console.log(`   ${APPLY ? "refreshed" : "would refresh"}  [${kind}] ${file}  (${norm(source).length} → ${next.trimEnd().length} chars, preamble ${preamble ? `${preamble.split("\n").length} lines kept` : "none"})`);
  if (APPLY) {
    // An impl is one entry inside the single `algorithms.json`, so it is mutated in memory and the whole
    // document flushed ONCE after the loop — writing per record would rewrite the file N times and leave
    // it half-updated if anything threw partway.
    if (kind === "impl") { rec.code = next; algorithmsDirty = true; }
    else writeFileSync(path, JSON.stringify({ ...rec, srcText: next }, null, 2) + "\n");
  }
}

if (APPLY && algorithmsDirty) writeFileSync(ALGOS_PATH, JSON.stringify(algorithms, null, 2) + "\n");

console.log(`\nseeds already matching the file: ${alreadyOk}`);
console.log(`${APPLY ? "refreshed" : "would refresh"}:                ${refreshed}`);
console.log(`SKIPPED — the record was edited:  ${skippedEdited}`);
for (const f of edited) console.log(`   ${f}`);
console.log(`SKIPPED — would drop a used export: ${skippedBreaking}`);
for (const f of breaking) console.log(`   ${f}`);
console.log(`SKIPPED — a record cannot resolve its imports: ${skippedUnresolvable}`);
for (const f of unresolvableList) console.log(`   ${f}`);
if (!APPLY) console.log("\n(dry run — pass --apply to write)");
