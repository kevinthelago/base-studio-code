// Promote a LIVE STORE record into the PACKAGED SEED — the step that makes its file retirable.
//
// WHY IT IS NEEDED AT ALL. `emit-records.mjs` materializes a retired module from the SEED, never from the
// store: the seed is what ships, and the store is a per-machine working copy. So a module whose record
// exists only in the store cannot be retired however good that record is — 633 of 882 modules were in
// exactly that state, which is why the candidate pool had been stuck at single digits.
//
// WHAT IT WILL AND WILL NOT PROMOTE. Only a record whose CODE already matches its file, compared through
// `scripts/lib/recordSource.mjs` — the same module the census uses, so the two can never disagree about
// which files are safe (a census that grades differently from the tool that acts is worse than either
// being wrong alone). Everything else is reported and skipped:
//
//   BODY-DIFFERS   the record is not the same module as the file. Promoting it would ship the record's
//                  behaviour under the file's name — silently, since it still compiles. Adjudicate first.
//   import.meta.glob   a VITE build-time transform. esbuild emits it verbatim and it is not a function at
//                  runtime, so the record throws the moment a graph consumer evaluates it. Retiring the
//                  file would leave nothing to fall back to.
//
// Components become one JSON per record under `src-tauri/data/components/app/<folder>/<id>.json`, matching
// the layout `seed.ts` globs. Impls are appended to `src-tauri/data/knowledge/algorithms.json`.
//
//   node scripts/promote-records.mjs --store <ui-list-full.json> --impls <graph-impl-list.json> [--apply]
//                                    [--limit N] [--only <src-path>]
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { norm, codeOnly, splitPreamble, fileAsRecordSource, runtimeImports, seedAdoption } from "./lib/recordSource.mjs";
import { libraryCarryClosure } from "./lib/graphClosure.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i > -1 ? argv[i + 1] : null; };
const APPLY = argv.includes("--apply");
const LIMIT = flag("--limit") ? Number(flag("--limit")) : Infinity;
/** Replace a STALE existing seed with the store record, when the record is the file and the seed is not.
 *  Opt-in, never the default — see the guard it relaxes, at the component write below. */
const ADOPT_SEED = argv.includes("--adopt-seed");
/** Adopt DESPITE the export-loss refusal, for the records named here — never as a blanket flag.
 *
 *  The refusal ("adopting would drop export(s) X") is right by default: a seed that declares more than
 *  the record is usually the seed being ahead. But a seed can also be a PREVIEW-SHAPED derivative that
 *  declares names the FILE never had, and then X is surface nothing has ever been able to import. The
 *  distinguishing measurement is not "does the name appear" — `Team` and `Persona` appear everywhere —
 *  it is whether anything imports X **from that record's own specifier**. Ten of eleven refusals
 *  measured zero such importers across `src/`, the component seed and `algorithms.json`; the eleventh
 *  (`treeexplorerpage`, `TreeNodeData`) measured one and is NOT listed here.
 *
 *  Per-id and explicit, so the drop is reviewable in the command that caused it. */
const ALLOW_DROP = new Set((flag("--allow-drop") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const ONLY = flag("--only");
const storeArg = flag("--store"), implsArg = flag("--impls");
if (!storeArg || !implsArg) {
  console.error("usage: node scripts/promote-records.mjs --store <bsc ui list --full> --impls <bsc graph impl list> [--apply] [--limit N] [--only <path>]");
  process.exit(2);
}

/** A VITE build-time transform — see the header. */
const BUILD_TIME_ONLY = /\bimport\s*\.\s*meta\s*\.\s*glob\b/;

/** Every `.ts`/`.tsx` module under `src/` (tests excluded), as `src/`-relative paths. */
function listModules(dir = join(REPO, "src"), rel = "") {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listModules(join(dir, e.name), r));
    // `.d.ts` is AMBIENT TYPE INFORMATION, not a module. tsc reads it because it is INCLUDED, never
    // because something imports it — so no resolver can substitute a record for it, and no record can
    // carry its meaning. `src/vite-env.d.ts` matched `\.ts$`, was harvested as a module, promoted, and
    // retired; the whole typecheck then failed on `*.css` and `*?raw` side-effect imports, because the
    // file that declared those wildcards was gone. Nothing downstream could have caught it: there is no
    // importer to break, which is exactly why it has to be excluded HERE.
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(r);
  }
  return out;
}

/** Every `id` the packaged component seed already uses, from ANY folder. `SEED_COMPONENTS` globs the tree
 *  flat, so an id is unique across the whole seed, not per directory. */
function seededIds() {
  const out = new Set();
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith(".json") || statSync(p).size > 4_000_000) continue;
      try { const r = JSON.parse(readFileSync(p, "utf8")); if (r?.id) out.add(r.id); } catch { /* not a record */ }
    }
  })(join(REPO, "src-tauri", "data", "components", "app"));
  return out;
}

/** id → the path its seed JSON actually occupies. `SEED_COMPONENTS` globs the tree FLAT and keys by id,
 *  so a record's identity is its id and NOT where the file sits — which is why an adoption has to find
 *  the existing seed by id rather than at a path derived from the store record's `folder`, a field that
 *  can and does disagree with reality. */
function seedPathsById() {
  const out = new Map();
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith(".json") || statSync(p).size > 4_000_000) continue;
      try { const r = JSON.parse(readFileSync(p, "utf8")); if (r?.id && !out.has(r.id)) out.set(r.id, p); } catch { /* not a record */ }
    }
  })(join(REPO, "src-tauri", "data", "components", "app"));
  return out;
}

/** Specifiers a packaged seed already provides — promoting one of these again would be a duplicate. */
function seededSpecifiers() {
  const out = new Set();
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith(".json") || statSync(p).size > 4_000_000) continue;
      let r;
      try { r = JSON.parse(readFileSync(p, "utf8")); } catch { continue; }
      if (typeof r?.provides === "string") out.add(r.provides.trim());
    }
  })(join(REPO, "src-tauri", "data", "components"));
  for (const im of algorithms.implementations ?? []) if (typeof im?.provides === "string") out.add(im.provides.trim());
  return out;
}

const ALGOS_PATH = join(REPO, "src-tauri/data/knowledge/algorithms.json");
const algorithms = JSON.parse(readFileSync(ALGOS_PATH, "utf8"));

const components = JSON.parse(readFileSync(storeArg, "utf8"));
const impls = JSON.parse(readFileSync(implsArg, "utf8"));
const bySpec = new Map();
for (const c of components) if (typeof c.provides === "string" && (c.srcText || "").trim()) bySpec.set(c.provides.trim(), { kind: "component", rec: c, source: c.srcText });
for (const i of impls) if (typeof i.provides === "string" && (i.code || "").trim() && !bySpec.has(i.provides.trim())) bySpec.set(i.provides.trim(), { kind: "impl", rec: i, source: i.code });

const seeded = seededSpecifiers();
const seedIds = seededIds();
const seedPathById = seedPathsById();

/** Every specifier a RECORD may import: a registered platform module, or one some record provides.
 *  Mirrors what `platformBoundary.test.ts` asserts — promoting a record whose imports nothing can answer
 *  turns a green gate red the moment it is packaged (`detachedtabstrip` needs `@/app/chrome/Titlebar`
 *  and `@tauri-apps/api/window`, neither of which is registered). */
const resolvable = new Set(JSON.parse(readFileSync(join(REPO, "src-tauri/data/ui/platform-modules.json"), "utf8")));
// THE PACKAGED SEED COUNTS, and leaving it out is what made this over-refuse. `emit-records.mjs`
// materializes the SEED — never the store — into `.bsc-records/`, so a specifier the seed provides is
// precisely what the bundle will resolve. Building `resolvable` from the registry and the STORE alone
// meant every module whose file had been retired in favour of a seed record read as unresolvable:
// `@/features/glance/GlanceWorkspace` is provided by `glancepage.json` and was still reported as
// needing an answer, because the store copy of that record carries no `provides`. Measured: the
// unresolvable bucket fell 29 → 23 and the distinct unanswered specifiers 34 → 23. The modules it
// released mostly moved on to the NEXT check (`unclosed-composes` 24 → 28, `body differs` 11 → 13),
// which is the honest shape of it — passing one gate exposes the following one rather than promoting.
for (const s of seeded) resolvable.add(s);
for (const spec of bySpec.keys()) resolvable.add(spec);
for (const c of components) resolvable.add(`@/components/${c.id}`);
for (const im of algorithms.implementations ?? []) if (typeof im?.provides === "string") resolvable.add(im.provides.trim());
const specOf = (f) => "@/" + f.replace(/\.(tsx?|jsx?)$/, "").replace(/\/index$/, "");

const promote = { component: [], impl: [] };
let skippedAtWrite = 0; // written-guard declines, subtracted from the final count (see the tail of this file)
let adopted = 0; //        stale seeds replaced by the store record under --adopt-seed

/** The file, read as a record would hold it — memoized, since the adoption check re-reads it per record. */
const fileSrcCache = new Map();
const fileSrcOf = (f) => {
  if (!fileSrcCache.has(f)) fileSrcCache.set(f, fileAsRecordSource(join(REPO, "src", f), f));
  return fileSrcCache.get(f);
};
const skipped ={ bodyDiffers: 0, buildTimeOnly: [], alreadySeeded: 0, noRecord: 0, pageRecord: [], unresolvable: [], uncompilable: [], unclosedComposes: [] };

for (const file of listModules()) {
  if (ONLY && file !== ONLY) continue;
  const spec = specOf(file);
  if (seeded.has(spec)) { skipped.alreadySeeded++; continue; }
  const hit = bySpec.get(spec);
  if (!hit) { skipped.noRecord++; continue; }
  if (BUILD_TIME_ONLY.test(hit.source)) { skipped.buildTimeOnly.push(file); continue; }
  // A `role: page` record is an APP SCREEN as far as `shadowPages.test.ts` is concerned, and that guard
  // demands every one be catalogued. Promoting a page therefore fails the suite until someone adds it to
  // SHADOW_PAGES with its `ensurePlatform` — a deliberate, per-page act, not a bulk promotion.
  if (hit.kind === "component" && hit.rec.role === "page" && hit.rec.pageKind !== "kit") { skipped.pageRecord.push(file); continue; }
  const unresolved = runtimeImports(hit.source)
    .filter((sp) => sp.startsWith("@/"))
    // `?raw` / `?url` are answered by the LOADER, not by registration: `makeRequire` calls
    // `rawImportSpec` and returns the string the importer's contract promised. Counting them as
    // unresolvable demands a registration that cannot exist — a specifier carrying a query is not a
    // registry key.
    .filter((sp) => !resolvable.has(sp) && !/\.(css|svg|png)$/.test(sp) && !/\?(raw|url)$/.test(sp));
  if (unresolved.length) { skipped.unresolvable.push(`${file} — needs ${unresolved.slice(0, 3).join(", ")}`); continue; }

  // The gate: is the record the SAME module as the file? Compared as a record would HOLD it — imports
  // absolutized, asset imports dropped — so a difference of form is never mistaken for a difference of
  // substance (that mistake cost 21 candidates the first time round).
  const fileSrc = fileAsRecordSource(join(REPO, "src", file), file);
  const body = splitPreamble(norm(hit.source), fileSrc)[1];
  if (body !== fileSrc && codeOnly(body) !== codeOnly(fileSrc)) { skipped.bodyDiffers++; continue; }

  if (promote.component.length + promote.impl.length >= LIMIT) break;
  promote[hit.kind].push({ file, spec, rec: hit.rec });
}

// FIXED POINT. Resolvability has to be judged against what the PACKAGE will hold once this run lands —
// registry ∪ already-seeded ∪ promoted-here — not against the live store, which knows records that will
// still be missing from the shipped seed afterwards. That is circular (whether A is promotable depends on
// whether B is), so it is settled by iterating until nothing more drops.
//
// It also covers BARE specifiers, not just `@/…`: `platformBoundary` checks those too (#4224), and
// `detachedtabstrip` failed on `@tauri-apps/api/window` after an earlier pass that only looked at `@/`.
const REGISTERED = new Set(JSON.parse(readFileSync(join(REPO, "src-tauri/data/ui/platform-modules.json"), "utf8")));
// `?raw` / `?url` are excluded for the same reason as `.css` beside them: the LOADER answers those
// (`makeRequire` → `rawImportSpec`), so demanding a registration asks for a registry key that cannot
// exist. This pass and the `@/`-only scan above are two filters over the same question, and this
// exclusion had to be added to BOTH — the first fix covered only the earlier one, so `?raw` kept
// blocking `runtimeFault.ts` from the second. Worth collapsing into one definition next time either
// changes.
const importsOf = (src) =>
  runtimeImports(src).filter(
    (sp) => !/^\.\.?\//.test(sp) && !/\.(css|svg|png)$/.test(sp) && !/\?(raw|url)$/.test(sp),
  );

for (let pass = 0; pass < 20; pass++) {
  const willExist = new Set([...REGISTERED, ...seeded]);
  for (const kind of ["component", "impl"]) for (const p of promote[kind]) { willExist.add(p.spec); willExist.add(`@/components/${p.rec.id}`); }
  let dropped = 0;
  for (const kind of ["component", "impl"]) {
    promote[kind] = promote[kind].filter((p) => {
      const src = p.rec.srcText ?? p.rec.code ?? "";
      const missing = importsOf(src).filter((sp) => !willExist.has(sp));
      if (!missing.length) return true;
      dropped++;
      skipped.unresolvable.push(`${p.file} — needs ${missing.slice(0, 3).join(", ")}`);
      return false;
    });
  }
  if (!dropped) break;
}

// DOES IT COMPILE AS TSX? The runtime loader compiles every record with esbuild's **tsx** loader, and TSX
// is not a superset of TS: `<T>(x) => x` is a generic arrow in a `.ts` file and an unclosed JSX element in
// a `.tsx` one. So a module that `tsc` and Vite accept all day can be uncompilable AS A RECORD —
// `deployEnv.ts` is exactly that, and it slipped past every gate above because its record matches its
// file perfectly. The file is fine; the record cannot exist.
//
// Batched through one esbuild invocation rather than 391: each is ~300ms of process start, and the whole
// set compiles in well under a second together. esbuild names every file it could not build, which is the
// list wanted here.
{
  const tmp = join(REPO, ".promote-compile-check");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const all = [...promote.component, ...promote.impl];
  const nameOf = (i) => `m${String(i).padStart(4, "0")}.tsx`;
  all.forEach((p, i) => writeFileSync(join(tmp, nameOf(i)), p.rec.srcText ?? p.rec.code ?? ""));
  const res = spawnSync("npx", ["esbuild", `${tmp}/*.tsx`, "--loader:.tsx=tsx", "--format=cjs", `--outdir=${tmp}/out`], {
    cwd: REPO, shell: true, encoding: "utf8",
  });
  const broken = new Set([...(res.stderr ?? "").matchAll(/m(\d{4})\.tsx/g)].map((m) => Number(m[1])));
  if (broken.size) {
    const keep = { component: [], impl: [] };
    all.forEach((p, i) => {
      if (broken.has(i)) skipped.uncompilable.push(`${p.file} — does not compile as TSX`);
      else keep[promote.component.includes(p) ? "component" : "impl"].push(p);
    });
    promote.component = keep.component;
    promote.impl = keep.impl;
  }
  rmSync(tmp, { recursive: true, force: true });
}

// DOES ITS `composes` CLOSE? An impl names the impls it builds on, and `knowledge.test.ts` asserts that
// every one of those ids is a REAL impl in the seed. Promoting an impl whose `composes` points at
// something still store-only therefore breaks the seed the moment it lands — measured: the first
// unfiltered run promoted 35 impls and left 33 dangling references, reddening the gate.
//
// Some of those targets can NEVER be satisfied. `console.ts` composes `achievements.ts` and
// `agent-profiles.ts`, both of which use `import.meta.glob` and so can never be records at all. Waiting
// for them is not a matter of ordering; that impl is simply not promotable until its dependency stops
// being build-time-only.
//
// A FIXPOINT, not one pass: dropping an impl can dangle another that composed it, so this repeats until
// nothing more falls out — the same shape as the compile check above.
// CARRY the LIBRARY records a promotion composes, instead of refusing the promotion (#close-the-composes-closure).
//
// Most refusals above are ordering that settles itself. The rest were not: 10 impls were blocked on
// function records harvested out of the SAME FILE as their consumer (`fnv1a32.ts` from `hash.ts`,
// `merge-role-defaults.ts` from `roleModel.ts`), and those compose the TypeScript language PRIMITIVES —
// of which the seed held exactly one, `typescript.number`, while the store held six. So the biggest wall
// on the board was mostly a seed gap in the language kit's base.
//
// A record with NO `provides` answers no specifier, so shipping it cannot change what the app renders;
// it only makes the graph's own references resolve. One WITH `provides` is a global override and is
// never carried — it earns its place through the gate above. `libraryCarryClosure` holds that rule, and
// its unit tests hold the refusals.
const carried = [];
{
  const seeded = new Set((algorithms.implementations ?? []).map((i) => i.id));
  for (const p of promote.impl) seeded.add(p.rec.id);
  const byId = new Map(impls.map((i) => [i.id, i]));
  const roots = promote.impl.flatMap((p) => p.rec.composes ?? []).filter((c) => !seeded.has(c));
  const { carry } = libraryCarryClosure({ roots, byId, seeded });
  for (const id of carry) carried.push(byId.get(id));
}

{
  const implIds = new Set((algorithms.implementations ?? []).map((i) => i.id));
  for (const p of promote.impl) implIds.add(p.rec.id);
  for (const c of carried) implIds.add(c.id);
  // A COMPOSED id whose module is already RESOLVABLE closes the closure just as well as a seeded impl.
  //
  // The check below exists so a promoted record's dependencies can be resolved. It was asking a narrower
  // question — "is this composed id a seeded impl?" — which no permanently-file module can ever satisfy:
  // 7 of the 34 blocking ids are `import.meta.glob` modules (`achievements`, `agentProfiles`,
  // `componentBundle`, …) that CANNOT be records at all, so every record composing one was held forever
  // on a condition it could not meet. Those resolve through the platform registry, which is exactly what
  // registration is for.
  //
  // So: an id also counts as closed when the record it names provides — or its `src` implies — a
  // specifier that `resolvable` already answers. Same standard the import check uses, applied to the
  // metadata rather than to the import list.
  // id → record, over BOTH stores. `byId` in the block above is scoped to it, and a composed id can name
  // a component as easily as an impl, so this index has to span both.
  const recById = new Map();
  for (const i of impls) recById.set(i.id, i);
  for (const c of components) if (!recById.has(c.id)) recById.set(c.id, c);
  const specForComposedId = (id) => {
    const rec = recById.get(id);
    if (!rec) return null;
    if (typeof rec.provides === "string" && rec.provides.startsWith("@/")) return rec.provides.trim();
    return typeof rec.src === "string"
      ? "@/" + rec.src.split("\\").join("/").replace(/^src\//, "").replace(/\.tsx?$/, "").replace(/\/index$/, "")
      : null;
  };
  const closedByResolution = (id) => {
    if (seeded.has(id)) return true;                 // a seeded COMPONENT record, not just an impl
    const spec = specForComposedId(id);
    return Boolean(spec && resolvable.has(spec));
  };
  for (let settled = false; !settled; ) {
    settled = true;
    const keep = [];
    for (const p of promote.impl) {
      const missing = (p.rec.composes ?? []).filter((c) => !implIds.has(c) && !closedByResolution(c));
      if (missing.length === 0) {
        keep.push(p);
        continue;
      }
      skipped.unclosedComposes.push(`${p.file} — composes ${missing.slice(0, 3).join(", ")}`);
      implIds.delete(p.rec.id);
      settled = false;
    }
    promote.impl = keep;
  }
}

// Recompute the carry from what SURVIVED. The fixed point above can drop an impl for an unrelated
// reason, and a library record carried only for that impl would then be seeded with nothing referencing
// it — valid, but noise in a file whose whole job is to be reviewable.
const carriedKept = [];
{
  const seeded = new Set((algorithms.implementations ?? []).map((i) => i.id));
  for (const p of promote.impl) seeded.add(p.rec.id);
  const byId = new Map(impls.map((i) => [i.id, i]));
  const roots = promote.impl.flatMap((p) => p.rec.composes ?? []).filter((c) => !seeded.has(c));
  for (const id of libraryCarryClosure({ roots, byId, seeded }).carry) carriedKept.push(byId.get(id));
}

console.log(`promotable: ${promote.component.length} component(s) + ${promote.impl.length} impl(s)` +
  (carriedKept.length ? ` (+ ${carriedKept.length} library record(s) carried to close their composes)` : ""));
for (const c of carriedKept) console.log(`   carry: ${c.id}${c.role === "primitive" ? "  [language primitive]" : ""}`);
console.log(`skipped — already seeded ${skipped.alreadySeeded}, no record ${skipped.noRecord}, body differs ${skipped.bodyDiffers}, build-time-only ${skipped.buildTimeOnly.length}, role:page ${skipped.pageRecord.length}, unresolvable ${skipped.unresolvable.length}, uncompilable ${skipped.uncompilable.length}, unclosed-composes ${skipped.unclosedComposes.length}`);
for (const f of skipped.buildTimeOnly) console.log(`   import.meta.glob: ${f}`);
for (const f of skipped.pageRecord) console.log(`   role:page (catalogue it in shadowPages first): ${f}`);
for (const f of skipped.unresolvable) console.log(`   unresolvable import: ${f}`);
for (const f of skipped.uncompilable) console.log(`   ${f}`);
for (const f of skipped.unclosedComposes) console.log(`   unclosed composes: ${f}`);

// NAME what will be promoted, not just how many. Every SKIPPED bucket above is named; the promotable
// set was the one that reported a bare count — which forced the operator to `--apply` in order to find
// out what `--apply` would do, the single thing a dry run exists to avoid.
for (const r of promote.component) console.log(`   + component ${r.file}`);
for (const r of promote.impl) console.log(`   + impl      ${r.file}`);

if (!APPLY) {
  console.log("\n(dry run — pass --apply to write)");
  process.exit(0);
}

// COMPONENTS — one JSON per record, at the position `seed.ts` globs.
//
// A seed carries CONTENT, not provenance. `history`/`rev`/`updatedAt`/`updatedBy` are per-machine facts
// about who last wrote the local store, and `builtin`/`seedHash` are stamped at LOAD by `seed.ts`
// (`stampSeedHash({...projectComponent(json), builtin: true})`). Writing the raw store record put all of
// them in the file — a 98-line diff of one component's local edit history — so the shape is pinned to
// what an existing seed actually holds.
const SEED_FIELDS = ["id", "name", "kitId", "role", "provides", "srcText", "composes", "src", "props", "folder", "tests", "variants", "animations", "themeSystem", "pageKind", "shapes", "guidance", "whenUse", "whenNot", "tags", "analytics"];
for (const { rec, file } of promote.component) {
  // AN EXISTING SEED IS FOUND BY ID, ANYWHERE — not at the folder-derived path. `SEED_COMPONENTS` globs
  // the tree FLAT and keys by id, so where a record's JSON sits is not part of its identity, and a
  // store record's `folder` can disagree with where its seed actually lives: `plannerlibrarypane` is
  // `folder: "planner"` in the store while its seed is at `features/planner/bodies/`. Deriving the path
  // from `folder` made `existsSync` false, so the write was not treated as an adoption, and the
  // duplicate-id guard then refused it — correctly, since writing would have put a SECOND record with
  // that id under a second folder (the `console-pane-menu` failure). Right refusal, wrong question.
  //
  // It matters beyond tidiness: the resolvability fixed point runs BEFORE these write-time declines, so
  // a record promoted on the assumption that its dependency would land can dangle when that dependency
  // is refused here. `featuresstagebody` shipped importing `@/features/planner/bodies/PlannerLibraryPane`
  // with nothing providing it, and `platformBoundary.test.ts` caught it.
  const folder = typeof rec.folder === "string" && rec.folder ? rec.folder : "misc";
  const existingPath = seedPathById.get(rec.id);
  const dir = existingPath ? dirname(existingPath) : join(REPO, "src-tauri/data/components/app", folder);
  const path = existingPath ?? join(dir, `${rec.id}.json`);
  // NEVER overwrite an existing seed. The skip above keys on `provides`, but the write keys on
  // `<folder>/<id>` — a record whose `provides` differs from the seed occupying that path slips through
  // and clobbers it. Seven curated seeds were overwritten before this guard existed.
  //
  // `--adopt-seed` is the ONE narrow exception, and it inverts the case the guard was written for.
  // The guard protects a CURATED seed from a worse record. Here the seed is the worse copy: it is
  // BEHIND the file while the store record IS the file — which the promotion gate above has already
  // proven, since a record only reaches this loop when its body matches. Four records were in that
  // state (`statusbar`, `titlebar`, `terminalbanners`, `skills-lessons-tab`), three of them carrying
  // no `provides` at all, and `titlebar`'s seed was missing the `WindowControls` export its file has —
  // so retiring the file with that seed in place would have shipped a module short an export.
  //
  // The adoption is REFUSED when the existing seed already matches the file (nothing to gain) or when
  // it would drop an export the seed has and the record does not. Neither is a judgement call: both
  // are the same three-way `refresh-drifted-seeds.mjs` grades on, read in the other direction.
  let adopting = false;
  if (existsSync(path)) {
    const seedRec = JSON.parse(readFileSync(path, "utf8"));
    // The DECISION lives in `recordSource.mjs` as a pure function — this script runs on import, so
    // anything embedded here cannot be unit-tested, and an untested overwrite rule is the last thing
    // this file should carry.
    const { verdict, reason, lost } = seedAdoption({
      seedSrcText: seedRec.srcText ?? "", seedProvides: seedRec.provides ?? null,
      recordSrcText: rec.srcText ?? "", recordProvides: rec.provides ?? null,
      fileSrc: fileSrcOf(file),
    });
    if (!ADOPT_SEED) { console.log(`   SKIPPED (a seed already occupies that path): ${file} → ${rec.id}.json${verdict === "adopt" ? " — it is STALE; --adopt-seed replaces it" : ""}`); skippedAtWrite++; continue; }
    // The export-loss refusal is the ONE that `--allow-drop` can override, and only for a record named
    // on the command line. `lost` being non-empty is what identifies that refusal — a refusal for any
    // other reason is not overridable here, so the flag cannot become a blanket "write anyway".
    const overriding = verdict === "refuse" && lost?.length && ALLOW_DROP.has(rec.id);
    if (verdict !== "adopt" && !overriding) { console.log(`   ${verdict === "keep" ? "kept" : "REFUSED"} (${reason}): ${rec.id}`); skippedAtWrite++; continue; }
    if (overriding) console.log(`   ADOPTED DESPITE dropping ${lost.join(", ")} (--allow-drop, measured: no importer of it from ${rec.provides}): ${rec.id}`);
    console.log(`   adopted the store record over a stale seed: ${rec.id}  (${reason})`);
    adopted++;
    adopting = true;
  }
  // AND the ID must be free ANYWHERE in the seed, not just at this path. The check above keys on
  // `<folder>/<id>.json`, so the same id under a DIFFERENT folder sails past it — which is what happened:
  // `console-pane-menu` already existed under `app/console/`, this wrote a second under
  // `app/console/panes/`, and `SEED_COMPONENTS` (a flat glob) then held two records with one id. Every
  // boot, `reconcileSeed` reported the id as pristine-but-changed and re-pushed it, forever. The app still
  // worked; three unrelated `store.test.ts` cases were the only thing that noticed, and they named the
  // RECORD rather than the duplication.
  // (An ADOPTION is the one case where the id being present is the point — it is the seed being
  //  replaced in place, at this exact path, not a second record under the same id.)
  if (!adopting && seedIds.has(rec.id)) { console.log(`   SKIPPED (that id is already in the seed elsewhere): ${file} → ${rec.id}`); skippedAtWrite++; continue; }
  seedIds.add(rec.id);
  const out = {};
  for (const k of SEED_FIELDS) if (rec[k] !== undefined) out[k] = rec[k];
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
}

// IMPLS — appended to the one algorithms document, sorted by id so the file stays reviewable and a
// re-run produces the same bytes.
if (promote.impl.length || carriedKept.length) {
  const KEEP = ["code", "composes", "domain", "folder", "id", "name", "provides", "ref", "role", "src", "tech"];
  // NEVER APPEND A DUPLICATE ID. The component write has refused this since seven curated seeds were
  // clobbered; the impl write did not, and an id comes from the FILE STEM — so promoting
  // `features/algorithms/viz/examples/sort.ts` appended a SECOND `sort.ts` beside a curated one, and
  // `knowledge.test.ts` failed with "expected 603 to be 604". Nothing upstream caught it: `bsc graph
  // harvest` refuses a stem collision only when it can compare `src`, and the curated entry had none.
  //
  // Under `--adopt-seed` the newer record REPLACES the existing entry, which is the right move when the
  // existing one is a partial projection of the same module — the `sort.ts` case exactly: 28 lines with
  // no `provides` and no `src`, against the full 90-line module that answers the specifier.
  const byId = new Map(algorithms.implementations.map((e, i) => [e.id, i]));
  // Every id that WILL be an impl once this run finishes — the seeded ones plus everything being written.
  // `composes` is filtered against it below.
  const willBeImpl = new Set(algorithms.implementations.map((e) => e.id));
  for (const rec of [...carriedKept, ...promote.impl.map((p) => p.rec)]) willBeImpl.add(rec.id);
  for (const rec of [...carriedKept, ...promote.impl.map((p) => p.rec)]) {
    const entry = {};
    for (const k of KEEP) if (rec[k] !== undefined) entry[k] = rec[k];
    if (!Array.isArray(entry.composes)) entry.composes = [];
    // DROP a composes target that is not an impl. `composes` models an edge in the ALGORITHM graph, so a
    // target that is a registered platform module or a component record is not an edge it can express —
    // and writing one produces a DANGLING reference the seed's own integrity guard rejects
    // ("every composes target is a real impl of the SAME tech — the referential integrity a promotion
    // must not break"). It caught exactly this: `console.ts → store-types.ts`, `→ achievements.ts`,
    // `→ agent-profiles.ts`, none of which are impls or ever can be (the last two are
    // `import.meta.glob` modules).
    //
    // Dropping is not losing the dependency: the record still IMPORTS the module and still resolves it
    // through the registry. Only the graph EDGE goes, and that edge never existed.
    const dropped = entry.composes.filter((c) => !willBeImpl.has(c));
    if (dropped.length) {
      entry.composes = entry.composes.filter((c) => willBeImpl.has(c));
      console.log(`   ${entry.id}: dropped ${dropped.length} non-impl composes target(s) — ${dropped.slice(0, 3).join(", ")}`);
    }
    const at = byId.get(entry.id);
    if (at !== undefined) {
      if (!ADOPT_SEED) { console.log(`   SKIPPED (that impl id is already in the seed): ${entry.id}`); skippedAtWrite++; continue; }
      console.log(`   replaced the seeded impl with the promoted module: ${entry.id}`);
      algorithms.implementations[at] = entry;
      continue;
    }
    byId.set(entry.id, algorithms.implementations.length);
    algorithms.implementations.push(entry);
  }
  algorithms.implementations.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  writeFileSync(ALGOS_PATH, JSON.stringify(algorithms, null, 2) + "\n");
}
// COUNT WHAT LANDED, NOT WHAT WAS PLANNED. This used to print the size of the promote list — the number
// taken BEFORE the never-overwrite-a-seed guard runs — so a run that wrote 43 records reported 49, and the
// six it declined were visible only as loose SKIPPED lines further up. A tool that overstates its own
// output is worse than one that does nothing, because the next step trusts the number.
const landed = promote.component.length + promote.impl.length - skippedAtWrite;
console.log(
  `\npromoted ${landed} record(s) into the seed` +
    (adopted ? `, ${adopted} of them ADOPTED over a stale seed` : "") +
    (skippedAtWrite ? ` (${skippedAtWrite} declined — a seed already occupied the path)` : ""),
);
