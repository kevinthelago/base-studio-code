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
// `src/app/runtime/recordImports.test.ts` + `scripts/check-record-imports.mjs` are the standing guards
// (seed and store respectively) so a new one cannot appear unnoticed.
import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { relativeSpecifiers, aliasFor } from "./lib/recordSource.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [, , target, ...flags] = process.argv;
const DRY = flags.includes("--dry");
if (!target) {
  console.error("usage: node scripts/retire-module.mjs <src-relative-path-without-extension> [--dry]");
  process.exit(2);
}

const rel = target.replace(/\.(tsx?|jsx?)$/, "").replace(/^src\//, "");
const spec = `@/${rel}`;
const name = rel.split("/").pop();

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

/** Does this relative specifier, resolved from `fromDir`, name the module being retired? */
const resolvesToTarget = (fromDir, relSpec) => {
  const out = [];
  for (const p of `${fromDir}/${relSpec}`.split("/")) {
    if (p === "." || p === "") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/") === rel;
};

let rewrote = 0;
for (const f of files) {
  if (f === self) continue;
  const abs = join(REPO, "src", f);
  const before = readFileSync(abs, "utf8");
  const fromDir = f.replace(/\/[^/]+$/, "");
  // Both quote styles, and both `from '…'` and bare `import '…'` / `require('…')` forms.
  const after = before.replace(
    /((?:from|import|require|vi\.mock|vi\.doMock|vi\.unmock)\s*\(?\s*)(['"])(\.\.?\/[^'"]+)\2/g,
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
  if (!bin) return "no built `bsc` — run `node scripts/check-record-imports.mjs --fix` once one exists";
  try {
    const out = execFileSync(process.execPath, [join(REPO, "scripts/check-record-imports.mjs"), ...(DRY ? [] : ["--fix"])], {
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
