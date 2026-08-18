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
import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const colocated = ["test", "spec"]
  .flatMap((k) => [`${rel}.${k}.ts`, `${rel}.${k}.tsx`])
  .filter((p) => files.includes(p));

console.log(`retire ${rel}: ${rewrote} importer(s) rewritten to ${spec}`);
if (colocated.length) console.log(`   KEEPING its colocated test: ${colocated.join(", ")} — it now tests the record`);
if (DRY) {
  console.log(`   would delete src/${self}`);
} else {
  const abs = join(REPO, "src", self);
  if (existsSync(abs)) unlinkSync(abs);
  console.log(`   deleted src/${self}`);
}
