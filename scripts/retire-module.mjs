// Retire one seed-backed module: rewrite every relative importer to the alias, then delete the FILE —
// and only the file. The recipe, executable, so a tranche cannot drift from it by hand.
//
//   node scripts/retire-module.mjs shared/ui/controls/Button [--dry]
//
// THE COLOCATED TEST STAYS. Its relative import is rewritten like any other importer, after which it
// resolves through `tsconfig.paths` to the emitted `.bsc-records/` copy and the default gate goes on
// running it — against the module that actually ships, which is better coverage than it had. Deleting it
// would move its assertions into the record's `tests` data, where nothing in the gate executes them; that
// cost 31 assertions across the first two tranches. `src/app/runtime/retiredTests.test.ts` guards it.
//
// AFTERWARDS, run `node scripts/sync-shadow-catalogue.mjs` — a module catalogued in `shadowPages.ts`
// must become `file: null` and leave its glob, or `shadowPages.test.ts` fails. It is a separate sweep
// because it reconciles the whole catalogue against disk in one pass, which is cheaper and safer than
// each retirement editing the same file.
//
// AND REGENERATE THE PACKAGED KIT — `UPDATE_KITS=1 npx vitest run src/features/designs/lib/reactUiKit.gen.test.ts`.
// This is the fourth downstream obligation and the least obvious: `react-ui.json` VENDORS the transitive
// non-component SOURCES its components import, so retiring one leaves the kit holding a copy of a file
// that no longer exists. The 16-module tranche failed `reactUiKit.gen.test.ts` four ways for exactly
// this — including "53 unresolved first-party imports would break an emitted file" — because
// `.bsc-records/` materializes a retired `.ts` as `.tsx` while the kit manifest still named `.ts`.
// Nothing upstream of the kit test catches it: tsc, lint and the rest of vitest were all green.
//
// AND THE PLATFORM MANIFEST, the fifth — `UPDATE_KITS=1 npx vitest run src/features/designs/lib/platformModules.gen.test.ts`.
// A retired module becomes a specifier the platform registry SERVES, so `platform-modules.json` gains
// an entry per retirement. The 23-card tranche went 974 -> 997 and reddened
// `platformModules.gen.test.ts` on a gate where everything else passed. Small tranches can miss this
// (the 5-module deploy chain did not trip it), which makes it exactly the kind of step that looks
// optional until a bigger batch proves it is not.
//
// It rewrites `vi.mock("./x")` too, and that is not a nicety. A mock keys on the RESOLVED module, so when
// the consumer imports `@/a/b` while the test mocks `./b`, retiring the file makes those stop being the
// same module — and the mock SILENTLY STOPS APPLYING. The test still runs; it just exercises the real
// module against a fixture built for a fake. Four tests broke that way on the first 110-file tranche
// (`graphBridge`, `uiActivity`), and failing loudly was luck rather than design: a mock that quietly stops
// mocking usually just makes a test weaker.
//
// Quote-agnostic on purpose: a double-quote-only sweep missed `PreviewPaneShell.tsx`'s
// `from './StageScreenFrame'` and the typecheck found it instead. Rewriting is still not a substitute for
// running tsc afterwards — this handles the mechanical bulk, tsc is the oracle.
//
// AND THE SIXTH OBLIGATION — RECORDS, which this tool did not touch for its first 110 retirements.
// Every rewrite above walks `src/` only, so the FILE half of the codebase was maintained and the RECORD
// half silently was not. A record importing `./useDockBack` kept working only for as long as that
// neighbour was a file a bundler could resolve; retiring it armed the trap, and nothing in the gate
// looked — tsc, lint, vitest, the kit test and `platformBoundary` were green across every tranche while
// 35 store specifiers were already dead. The sweep below closes it, and
// `src/app/runtime/recordImports.test.ts` + `bsc ui imports` are the standing guards
// (seed and store respectively) so a new one cannot appear unnoticed.
import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  seedAnswersSpecifier, seedMatchesFile, fileAsRecordSource, importsSiblingsByRecordId,
  relativeSpecifiers, aliasFor, entriesImportingStatically,
} from "./lib/recordSource.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [, , target, ...flags] = process.argv;
const DRY = flags.includes("--dry");
if (!target) {
  console.error("usage: node scripts/retire-module.mjs <src-relative-path-without-extension> [--dry]");
  process.exit(2);
}

const rel = target.replace(/\.(tsx?|jsx?)$/, "").replace(/^src\//, "");
// A BARREL IS ADDRESSED BY ITS DIRECTORY. `lib/plannerCore/index.ts` answers `@/features/planner/lib/plannerCore`,
// never `…/plannerCore/index` — that is what `specOf` in `promote-records.mjs` derives, so it is what the
// record actually `provides`. Emitting the `/index` form rewrote three importers onto a specifier nothing
// answers, and typecheck caught it as TS2307 only after the file was already deleted.
const relSpecifier = rel.replace(/\/index$/, "");
const spec = `@/${relSpecifier}`;
const name = rel.split("/").pop();

// NEVER RETIRABLE: a module the BUILD CONFIG imports. `vite.config.ts` does
// `import { devWatchIgnored } from "./src/shared/lib/core/devWatchIgnore"`, and Vite bundles its own
// config BEFORE any plugin runs — so `vite/bscRecords.ts` is not installed yet and `.bsc-records/` can
// never serve it. There is also no `@/` alias out there: the config sits outside `src/` and imports by
// relative path.
//
// It is the deletion-gate-is-the-bundle class again, one level further out: `tsc`, `lint` and the whole
// vitest suite went GREEN after this module was retired, and only `npx vite build` failed —
// "Could not resolve './src/shared/lib/core/devWatchIgnore' in vite.config.ts". Read from the configs
// rather than hard-coded, so a new build-time importer is covered the day it is written.
{
  const CONFIGS = ["vite.config.ts", "vitest.config.ts", "e2e/vite.config.ts", "playwright.config.ts", "eslint.config.js"];
  const importers = CONFIGS.filter((c) => existsSync(join(REPO, c))).filter((c) =>
    new RegExp(`from\\s+["']\\.{1,2}/(?:\\.\\./)*src/${rel}(?:\\.[jt]sx?)?["']`).test(readFileSync(join(REPO, c), "utf8")),
  );
  if (importers.length) {
    console.error(
      `retire: REFUSED — ${rel} is imported by ${importers.join(", ")}. A build config is bundled before ` +
        `any plugin runs, so \`.bsc-records/\` can never serve it and only \`npx vite build\` would catch it.`,
    );
    process.exit(1);
  }
}

// NEVER RETIRABLE: the algorithms SEED modules exist precisely to BE files. A packaged node's `code` is
// generated FROM the module (`seedAlgorithms.gen.test.ts`, #3465), which is what makes "this node's code
// stands alone" a checked fact rather than a claim — tsc compiles it, its sibling test executes it, and
// the JSON is asserted byte-identical. Retiring one turns the generator back into a claim, and
// `llmEnergy.ts` went in a tranche before the census learned to exclude them.
//
// The CENSUS has excluded them since; this tool did not, and it is the one that actually deletes. That
// gap got sharper once those nodes gained a `provides`, because the module now looks record-backed to
// every other tool while still being the one thing a record must not replace.
if (/^shared\/lib\/algorithms\/[^/]+$/.test(rel)) {
  console.error(
    `retire: REFUSED — ${rel} is an algorithms SEED module. Its node's code is generated from this file, ` +
      `so deleting it turns the standalone guarantee back into a claim (seedAlgorithms.gen.test.ts, #3465).`,
  );
  process.exit(1);
}

/** Every `.ts`/`.tsx` under `src/`, as repo-relative paths — a real listing, never `existsSync`, which is
 *  case-insensitive on Windows and would let a case-mismatched path pass the check meant to catch it. */
const files = [];
(function walk(dir, r) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rr = r ? `${r}/${e.name}` : e.name;
    if (e.isDirectory()) walk(join(dir, e.name), rr);
    else if (/\.(ts|tsx)$/.test(e.name)) files.push(rr);
  }
})(join(REPO, "src"), "");

const EXT = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
const self = EXT.map((e) => rel + e).find((p) => files.includes(p));
if (!self) {
  console.error(`retire: no file under src/ for '${rel}' — already retired?`);
  process.exit(1);
}

// NEVER RETIRABLE: a module the ENTRY imports STATICALLY. `App.tsx` does
// `import { ConsoleGraphHost } from "@/app/console/ConsoleGraphHost"` at the top level, and the dev
// server's PRE-TRANSFORM pass resolves that alias to `/src/…` before the `bscRecords` plugin can answer —
// "Failed to load url /src/app/console/ConsoleGraphHost.tsx". Same shape as the build-config rule above:
// something needs the module before the plugin is in a position to serve it.
//
// IT IS THE EAGERNESS, NOT THE KIND. Eleven other `*GraphHost.tsx` retired in the same sweep without
// trouble, because they are reached through `lazyWorkspaces` / dynamic import. Only the one in the entry's
// synchronous graph broke — and ONLY `node scripts/dev-boot-check.mjs` saw it: typecheck, lint, the whole
// vitest suite and `npx vite build` were every one of them green while the app could not boot.
{
  // ONE definition, shared with the census (`retirement-candidates.mjs`). They disagreed while this was
  // inline here: the census offered four candidates the tool refused, every one for this rule.
  const importers = entriesImportingStatically(
    REPO,
    relSpecifier,
    (p) => readFileSync(p, "utf8"),
    (p) => existsSync(p),
  );
  if (importers.length) {
    console.error(
      `retire: REFUSED — ${rel} is imported STATICALLY by ${importers.join(", ")}. The dev server's ` +
        `pre-transform pass resolves that alias to \`/src/…\` before the records plugin can answer, so the ` +
        `app fails to boot — and only \`node scripts/dev-boot-check.mjs\` observes it.`,
    );
    process.exit(1);
  }
}

/** Does this relative specifier, resolved from `fromDir`, name the module being retired? */
const resolvesToTarget = (fromDir, relSpec) => {
  const out = [];
  for (const p of `${fromDir}/${relSpec}`.split("/")) {
    if (p === "." || p === "") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  // BOTH SPELLINGS reach a barrel: `./lib/plannerCore` (the directory) and `./lib/plannerCore/index`
  // (the file). Matching only the second left every directory-form importer untouched — which is the
  // half that actually breaks, since the directory form is what consumers normally write.
  const hit = out.join("/");
  return hit === rel || hit === relSpecifier;
};

// THE PRECONDITION FOR DELETING ANYTHING: the packaged SEED must already answer this module's
// specifier. That is what a retirement asserts — importers keep writing `@/x/y`, and once the file is
// gone the only thing that can answer them is a shipped record.
//
// TWO REAL FAILURES, one slice, both this same missing check:
//
//   * `promote-records` printed `SKIPPED (a seed already occupies that path) — it is STALE` for five
//     modules and they were retired anyway, leaving them deleted with the old preview-shaped derivative
//     still shipping. The recovery is worse than the bug: `promote-records` iterates FILES, so once the
//     file is gone the module is no longer a candidate and the stale seed can never be adopted.
//   * `pageheader`'s seed provided `@/shared/ui/pages/PageHeader` while the file is `pageHeader.tsx`.
//
// NOTHING ELSE CATCHES EITHER. tsc resolves case-insensitively on Windows, `vite build` passed, the
// whole vitest suite passed. The comparison here is therefore EXACT — a case-insensitive match would
// wave through precisely the bug that only breaks on someone else's filesystem.
//
// It reads the SEED, never the live store: the store is per-machine, and a store-only record is exactly
// the case that must be refused (making it shippable is what `promote-records` is for).
{
  const seedProvides = new Set();
  const seedSourceFor = new Map(); // provides → the record's source, for the body check below
  const walkSeed = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walkSeed(p); continue; }
      if (!e.name.endsWith(".json")) continue;
      try {
        const r = JSON.parse(readFileSync(p, "utf8"));
        if (typeof r?.provides === "string") {
          seedProvides.add(r.provides.trim());
          if (r.srcText) seedSourceFor.set(r.provides.trim(), r.srcText);
        }
      } catch { /* not a record */ }
    }
  };
  walkSeed(join(REPO, "src-tauri/data/components/app"));
  try {
    const algos = JSON.parse(readFileSync(join(REPO, "src-tauri/data/knowledge/algorithms.json"), "utf8"));
    for (const im of algos.implementations ?? []) if (typeof im?.provides === "string") {
      seedProvides.add(im.provides.trim());
      if (im.code) seedSourceFor.set(im.provides.trim(), im.code);
    }
  } catch { /* no algorithms seed */ }

  const { ok, nearMiss: near } = seedAnswersSpecifier({ spec, seedProvides });
  if (!ok) {
    console.error(
      `retire: REFUSED — no packaged seed record provides ${spec}, so deleting the file would leave its ` +
        `importers with nothing to resolve to.` +
        (near.length
          ? `\n   A seed provides ${near.join(", ")} — a CASE MISMATCH. The loader matches exactly, so this ` +
            `would keep working on Windows and break on a case-sensitive filesystem.`
          : `\n   Promote it first (\`node scripts/promote-records.mjs --store … --impls … --apply\`) and ` +
            `CHECK THAT RUN'S OUTPUT — a write it skipped is a seed that still holds the old record.`),
    );
    process.exit(1);
  }

  // ...AND IS THAT ANSWER THE SAME MODULE? Answering the specifier is necessary and not sufficient: a
  // seed record can respond to `@/x/y` while holding DIFFERENT code, and deleting the file then ships
  // the record's behaviour under the file's name — silently, because it still compiles. That is the
  // BODY-DIFFERS hazard `promote-records` refuses to promote through, and this step had no equivalent.
  //
  // It cost ten test failures in one sweep: `Dialog`, `ModalCard`, `ModalScrim` and `a11y` are all
  // body-differs records that happened to be seeded, so the specifier check waved them through and
  // retiring them swapped the app's focus management for the records' older copies.
  const seedSrc = seedSourceFor.get(spec);

  // NEVER RETIRABLE: a record that imports its SIBLINGS BY RECORD ID. `@/components/<id>` is resolved by
  // the runtime GRAPH LOADER against the record store — it is not a path, and nothing in the bundle can
  // resolve it. Retire the file and `.bsc-records/` materializes the record at that path, where the first
  // ordinary import of it dies with "Cannot find package '@/components/algorithms-kit-graph'".
  //
  // This is what `promote-records.mjs` is really refusing when it skips `role: page` wholesale, and
  // stating it as its own check makes the reason legible instead of a category ban. Four page files were
  // retired past that ban on the theory that the record "matched" its file once sibling ids were
  // canonicalized — true in the graph loader, false in the bundle, and `platformModules.gen.test.ts` was
  // the only thing that said so.
  if (seedSrc !== undefined) {
    const { any, specifiers } = importsSiblingsByRecordId(seedSrc);
    if (any) {
      console.error(
        `retire: REFUSED — the seed record providing ${spec} imports its siblings BY RECORD ID ` +
          `(${specifiers.slice(0, 3).join(", ")}${specifiers.length > 3 ? `, +${specifiers.length - 3}` : ""}). ` +
          `That form is resolved only by the runtime graph loader, so the record cannot be materialized ` +
          `into \`.bsc-records/\` as a bundle module — deleting the file would break the build.\n` +
          `   This module is graph-hosted: it stays a file until its siblings are reachable by specifier.`,
      );
      process.exit(1);
    }
  }

  if (seedSrc !== undefined) {
    const fileSrc = fileAsRecordSource(join(REPO, "src", self), self);
    if (!seedMatchesFile({ seedSrcText: seedSrc, fileSrc }).ok) {
      console.error(
        `retire: REFUSED — the seed record providing ${spec} does NOT match this file. Deleting it would ` +
          `ship the RECORD's behaviour under the file's name, and it would still compile.\n` +
          `   Adjudicate first: refresh the record from the file, or decide the record is the app and ` +
          `bring the file to it.`,
      );
      process.exit(1);
    }
  }
}

let rewrote = 0;
for (const f of files) {
  if (f === self) continue;
  const abs = join(REPO, "src", f);
  const before = readFileSync(abs, "utf8");
  const fromDir = f.replace(/\/[^/]+$/, "");
  // Both quote styles, and both `from '…'` and bare `import '…'` / `require('…')` forms.
  //
  // THE TRAILING SEGMENT IS OPTIONAL. `from "./"` and `from ".."` are real imports naming a DIRECTORY's
  // barrel, and requiring a name after the slash meant they were never rewritten — so retiring
  // `shared/ui/charts/index.ts` left `charts.test.tsx` importing `from "./"`, which typecheck then
  // reported as `Cannot find module './'` once the file was already gone. `emit-records.mjs` learned
  // this same lesson on carried tests and says so in its own regex; this one had not.
  const after = before.replace(
    /((?:from|import|require|vi\.mock|vi\.doMock|vi\.unmock)\s*\(?\s*)(['"])(\.{1,2}(?:\/[^'"]*)?)\2/g,
    (whole, head, q, relSpec) => (resolvesToTarget(fromDir, relSpec) ? `${head}${q}${spec}${q}` : whole),
  );
  if (after !== before) {
    rewrote++;
    console.log(`   ${DRY ? "would rewrite" : "rewrote"}  ${f}`);
    if (!DRY) writeFileSync(abs, after);
  }
}

// ── the RECORD half ──────────────────────────────────────────────────────────────────────────────
// The packaged SEED first: those are files in git, so this always runs, deterministically, and needs
// no built binary. It is a fence more than a sweep — `recordImports.test.ts` keeps the seed at zero
// relative specifiers, so this should find nothing and says so if it ever does.
const seedDir = join(REPO, "src-tauri/data/components/app");
const seedFiles = [];
(function walkSeed(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) walkSeed(join(dir, e.name));
    else if (e.name.endsWith(".json")) seedFiles.push(join(dir, e.name));
  }
})(seedDir);

let seedRewrote = 0;
for (const f of seedFiles) {
  const rec = JSON.parse(readFileSync(f, "utf8"));
  if (!rec.srcText || !rec.src) continue;
  const hits = relativeSpecifiers(rec.srcText).filter(({ spec: s }) => aliasFor(rec.src, s) === spec);
  if (!hits.length) continue;
  let text = rec.srcText;
  for (const { at, spec: s } of hits.reverse()) text = text.slice(0, at) + spec + text.slice(at + s.length);
  seedRewrote++;
  console.log(`   ${DRY ? "would rewrite" : "rewrote"}  seed record ${rec.id}`);
  if (!DRY) writeFileSync(f, `${JSON.stringify({ ...rec, srcText: text }, null, 2)}\n`);
}

/** The LIVE STORE, best effort. It needs the bundled `bsc`, which a fresh worktree may not have built —
 *  so a miss is REPORTED with the command to run rather than swallowed or fatal. Silence here is the
 *  exact failure this whole sweep exists to undo. */
function sweepStore() {
  const bin = [process.env.BSC_BIN, join(REPO, "target/release/bsc.exe"), join(REPO, "target/release/bsc")].find(
    (p) => p && existsSync(p),
  );
  if (!bin) return "no built `bsc` — run `bsc ui imports --fix` once one exists";
  try {
    const out = execFileSync(bin, ["ui", "imports", ...(DRY ? [] : ["--fix"])], {
      encoding: "utf8",
      env: { ...process.env, BSC_BIN: bin },
    });
    return out.trim().split("\n").slice(-1)[0];
  } catch (e) {
    // exit 1 just means "found something"; the report is still on stdout.
    return (e.stdout?.toString().trim().split("\n").slice(-1)[0] || e.message);
  }
}

const colocated = ["test", "spec"]
  .flatMap((k) => [`${rel}.${k}.ts`, `${rel}.${k}.tsx`])
  .filter((p) => files.includes(p));

console.log(`retire ${rel}: ${rewrote} importer(s) rewritten to ${spec}`);
console.log(`   seed records: ${seedRewrote} rewritten`);
console.log(`   store: ${sweepStore()}`);
if (colocated.length) console.log(`   KEEPING its colocated test: ${colocated.join(", ")} — it now tests the record`);
if (DRY) {
  console.log(`   would delete src/${self}`);
} else {
  const abs = join(REPO, "src", self);
  if (existsSync(abs)) unlinkSync(abs);
  console.log(`   deleted src/${self}`);
}
