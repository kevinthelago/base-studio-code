// Retiring a module must not retire its TESTS (#retire-the-rest, #record-tests-execute-in-the-gate).
//
// A record carries its colocated test as DATA (`tests: [{ name, src }]`, #3907). That is the right
// long-term shape — once a component's source is a store record compiled at runtime, a `.test.tsx` under
// `src/**` is no longer beside the thing it tests.
//
// ⚠️ THIS GUARD USED TO REQUIRE THE OPPOSITE, and the reason it changed matters. For as long as nothing
// in the gate could RUN a carried test, deleting the colocated file traded EXECUTED coverage for STORED
// coverage, silently and green — the first two retirement tranches did exactly that and took 31
// assertions out of the gate, five of which (BackButton) the record never carried at all. So the rule
// was "retire the module, KEEP the test file", which was correct as a consequence of a missing executor,
// not as a statement about where a test belongs.
//
// `scripts/emit-records.mjs` now materializes a record's carried tests into `.bsc-records/` beside the
// module they test, and `vitest.config.ts` includes that tree — so a carried test executes in the default
// gate, against the record that actually ships. The file may therefore go, and the rule becomes what it
// should always have been: a retired module's tests must RUN somewhere. Either copy satisfies that; NO
// copy running is the failure this guard exists to catch.
//
// It asks `planRecords()` rather than re-deriving the answer, so the guard cannot drift from the emitter
// it is guarding. `planRecords` deliberately WRITES NOTHING — calling `emitRecords` here would `rmSync`
// the tree out from under every other test file being collected in parallel.
import { describe, it, expect } from "vitest";
import { relativeImportSpecifiers } from "@/shared/lib/runtime/shadow/pageBinding";
import { planRecords } from "../../../scripts/emit-records.mjs";
import { blankComments } from "../../../scripts/lib/recordSource.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Every packaged seed, as the record objects the app would load. */
const seeds = import.meta.glob<{
  id?: string;
  provides?: string;
  /** Provenance — the file the record was harvested FROM. Present on records with no `provides`. */
  src?: string;
  tests?: { name?: string; src?: string }[];
}>("@data/components/app/**/*.json", { eager: true, import: "default" });

/** Every file under `src/`, keyed the way a specifier addresses it (`@/x/y` → `x/y`). */
const srcFiles = new Set(
  Object.keys(import.meta.glob("/src/**/*.{ts,tsx}", { eager: false })).map((p) => p.replace(/^\/src\//, "")),
);

const EXT = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
const hasFile = (base: string) => EXT.some((e) => srcFiles.has(base + e));

/** Is this specifier addressed at THIS app's source tree?
 *
 *  `@/components/<id>` and `@/src/…` records are foreign — mobile-studio-code screens and generated-app
 *  demos — and have no position under `src/` at all, so a colocated test is not even expressible for
 *  them. They are excluded because the rule cannot apply, not because the gap is acceptable: the 15 that
 *  carry an unrunnable test are REPORTED by every emit rather than hidden here. */
const isOwnSpecifier = (spec: string) =>
  ["@/app/", "@/features/", "@/shared/", "@/store/", "@/styles/"].some((p) => spec.startsWith(p));

const countAssertions = (src: string) => (src.match(/^\s*(it|test)\(/gm) ?? []).length;

/** Every packaged algorithm implementation, beside the component records globbed above. */
const allImpls = (
  JSON.parse(readFileSync(join(process.cwd(), "src-tauri/data/knowledge/algorithms.json"), "utf8")) as {
    implementations?: (typeof seeds)[string][];
  }
).implementations;

describe("a retired module keeps its tests in the gate", () => {
  it("every RETIRED record that carries tests has them EXECUTED — from src/, or from the emitted record", () => {
    const plan = planRecords();
    // The two ways a carried test reaches the gate. `shadowed` means a colocated file under `src/` still
    // runs it (so the record's copy is deliberately not emitted, to avoid double-counting); `tests` means
    // the file is gone and the record's own copy was materialized instead.
    const executed = new Set<string>([
      ...plan.tests.map((t: { spec: string }) => t.spec),
      ...plan.shadowed,
    ]);

    const gaps: string[] = [];
    let checked = 0;
    for (const rec of Object.values(seeds)) {
      const spec = typeof rec?.provides === "string" ? rec.provides.trim() : "";
      if (!spec.startsWith("@/") || !isOwnSpecifier(spec)) continue;
      if (hasFile(spec.slice(2))) continue; // the module is still here — not retired, nothing to preserve yet
      const carried = (rec.tests ?? []).reduce((n, t) => n + countAssertions(t.src ?? ""), 0);
      if (!carried) continue; // a record that never had a test cannot have lost one
      checked++;
      if (!executed.has(spec)) {
        const why = plan.unresolvable.find((u: { spec: string }) => u.spec === spec);
        gaps.push(
          `${spec} — ${carried} assertion(s) stored on the record, none executed` +
            (why ? ` (${why.missing.join(", ")} does not resolve)` : ""),
        );
      }
    }
    expect(
      gaps,
      `retired modules whose tests execute NOWHERE. Either keep the colocated test file, or make the ` +
        `record's carried copy resolvable so \`emit-records\` can materialize it:\n  ${gaps.join("\n  ")}`,
    ).toEqual([]);
    // Non-vacuity: if the seed glob or the specifier filter ever stops matching, an empty sweep would
    // read as a clean one. Assert the guard actually had records to judge.
    expect(checked, "the guard examined at least one retired record carrying tests").toBeGreaterThan(0);
  });

  it("a record whose colocated test file is gone actually gets its carried copy emitted", () => {
    // The half that makes deletion safe rather than merely permitted. Without an emitted copy, the test
    // above would still pass by treating "no file, no emit" as "nothing to preserve".
    const plan = planRecords();
    const emitted = plan.tests.filter((t: { spec: string }) => isOwnSpecifier(t.spec));
    expect(emitted.length, "own-specifier records materializing a carried test").toBeGreaterThan(0);
    // Every emitted test lands beside the module it tests — that mirrored position is what makes its
    // imports resolve the same way the module's own do.
    for (const t of emitted) {
      expect(t.rel, `${t.spec} emits beside its module`).toMatch(
        new RegExp(`^${t.spec.slice(2).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\.\\d+)?\\.test\\.tsx?$`),
      );
    }
  });

  it("a carried test's relative imports are rewritten to `@/`, so a sibling still in src/ resolves", () => {
    // `@/shared/ui/data/Avatar` carries a test importing `./LabelChip`, and LabelChip is still a FILE.
    // Emitted verbatim into `.bsc-records/`, that relative import reaches nothing — the two trees are not
    // bridged relatively — so the test would silently stop running on a green gate.
    // POSITIONS, not import-shaped TEXT. The scan used to be a bare regex over the whole source, and a
    // fixture is text: `pageBinding.test.ts` is a test FOR this very parser and its fixtures ARE import
    // statements, while `componentScan.test.ts` holds a component record whose `srcText` is
    // `"import { Dep } from './dep';"`. Both were refused for imports they do not have, and rewriting
    // them would have changed what they assert rather than fixing anything.
    //
    // `relativeImportSpecifiers` shares the anchored FROM_IMPORT / BARE_IMPORT of the repo's reference
    // scanner, so a specifier only counts at the start of a line — which is exactly what separates a
    // real import from one quoted inside a fixture. It keeps TYPE-ONLY imports, which `parseImports`
    // drops: esbuild erases them so they never become a require, but `tsc` still has to resolve them,
    // and resolution is the whole thing at stake when a test moves trees.
    const plan = planRecords();
    for (const t of plan.tests) {
      expect(relativeImportSpecifiers(t.src), `${t.spec} carries no unrewritten relative import`).toEqual([]);
    }
  });

  it("still refuses a GENUINE relative import — narrowing the scan must not blunt it", () => {
    // The half that keeps the narrowing honest. Loosening a guard is only safe if the case it exists
    // for still fails, and this one cost real coverage before anything checked: a carried test emitted
    // into `.bsc-records/` with a surviving `./sibling` reaches nothing and stops running on a green
    // gate. Both real forms, and the type-only one that `parseImports` would have waved through.
    expect(relativeImportSpecifiers(`import { x } from "./sibling";\n`)).toEqual(["./sibling"]);
    expect(relativeImportSpecifiers(`import type { X } from "../up/there";\n`)).toEqual(["../up/there"]);
    expect(relativeImportSpecifiers(`import "./styles.css";\n`)).toEqual(["./styles.css"]);
  });
});


// ── EDGES (integration-tests-become-graph-edges) ────────────────────────────────────────────────────
//
// The node twin above exists because "deleting a colocated test trades executed coverage for stored
// coverage behind a green gate" — it cost 31 assertions before anything checked. The edge tier is the
// same trade with the same shape, and it shipped with a STORE and a CLI and nothing that runs a test,
// so these assert the executing half before 51 cross-module tests are moved onto it.
describe("an edge test is executed, not merely stored", () => {
  // THE PATH RULE ITSELF now lives in `crates/bsc-emit/src/plan.rs::edge_test_path`, with all
  // five of the cases this block asserted carried over verbatim — including the two real
  // provenances (`shared/lib/security/…` keeping `node`, `shared/ui/overlay/…` keeping `.tsx`).
  // What stays here is what only the live plan can answer.

  it("accounts for EVERY edge that carries tests — emitted, shadowed, or declined with a reason", () => {
    const plan = planRecords();
    // The three buckets exist as arrays whatever the seed holds, so a reader can tell "no edges" from
    // "edges the emitter never looked at".
    for (const k of ["edgeTests", "edgeShadowed", "edgeUnresolvable"] as const) {
      expect(Array.isArray(plan[k]), `plan.${k} is a bucket`).toBe(true);
    }
    // Declined is never silent — the node tier learned this too: "has no test", "is shadowed" and
    // "cannot run" are three different states that look identical from outside.
    for (const u of plan.edgeUnresolvable) {
      expect(u.id, "a declined edge names itself").toBeTruthy();
      expect(u.detail, `${u.id} says WHY it was declined`).toBeTruthy();
    }
    // An edge test must never be emitted while its src/ file still runs — that double-counts.
    for (const t of plan.edgeTests) {
      expect(existsSync(join(process.cwd(), "src", t.rel)), `${t.id} is emitted AND still in src/`).toBe(false);
    }
  });

  it("carries the members onto the emitted file, so the relationship is readable where it runs", () => {
    for (const t of planRecords().edgeTests) {
      expect(t.members.length, `${t.id} spans 2+ records — one is a node test`).toBeGreaterThanOrEqual(2);
    }
  });

  // ── A MIGRATED TEST'S FILE MAY NOT COME BACK (`the-frontend-tests-are-records`) ──────────────────
  //
  // `plan_records` puts an edge in `edgeShadowed` when its `src` file still exists: "the file still
  // exists ⇒ IT is the copy that runs". Nothing was asserting that bucket, so a re-added file was a
  // SILENT second copy of the assertions — coverage intact, and two copies free to drift, which is
  // the exact failure records exist to remove. It is not hypothetical: the migration deletes the file
  // and the store keeps the test, so any later `git checkout`, revert or merge that resurrects the
  // path re-creates the pair.
  //
  // Unlike a node test, an edge is never MIRRORED — `bsc graph edge set --src` is the migration verb,
  // not a harvest — so a populated `edgeShadowed` has no legitimate reading. Reads the packaged SEED,
  // not the shared runtime store, so a half-finished migration in someone else's session cannot
  // redden this for everyone; only a COMMITTED one can.
  it("no edge test's file has come back to src/ — a shadowed edge is a second copy of the assertions", () => {
    const plan = planRecords();
    const seedEdges: { id?: string; src?: string; tests?: unknown[] }[] =
      (JSON.parse(readFileSync(join(process.cwd(), "src-tauri/data/knowledge/algorithms.json"), "utf8"))
        .edges ?? []) as { id?: string; src?: string; tests?: unknown[] }[];
    const srcOf = new Map(seedEdges.map((e) => [e.id ?? "", e.src ?? "(no src)"]));
    expect(
      plan.edgeShadowed.map((id: string) => `${id} — ${srcOf.get(id)} is back on disk`),
      "these edges carry a test AND the file they were migrated out of exists again. Delete the file " +
        "(the store copy is emitted into `.bsc-records/` and runs there), or drop the edge — but not both.",
    ).toEqual([]);
    // Non-vacuity: an empty seed and a seed nothing matched look identical from here.
    const withTests = seedEdges.filter((e) => (e.tests ?? []).length > 0).length;
    expect(withTests, "packaged edges carrying tests").toBeGreaterThanOrEqual(50);
  });

  // The node half of the same reappearance. `plan_records` shadows a record's WHOLE `tests` manifest
  // on one colocated file — `test_file_exists(repo, spec)` is a single check, not a per-entry one — so
  // re-adding `src/<spec>.test.ts` beside a record carrying five tests stops FOUR of them running while
  // the fifth reads as the file that replaced them. Measured on `session-roles.ts`, which carries five.
  it("no record carrying several tests has a colocated file — one file shadows the whole manifest", () => {
    // FLAT, exactly as `test_file_exists` in `crates/bsc-emit/src/plan.rs` is — `<spec><ext>`, never
    // the barrel form the guard below accepts. A looser check here would report a shadow the emitter
    // does not actually apply.
    const colocated = (base: string) =>
      [".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx"].some((e) => srcFiles.has(base + e));
    const carriers = [...Object.values(seeds), ...(allImpls ?? [])].filter(
      (r) => (r.tests ?? []).length > 1 && (r.provides ?? "").startsWith("@/"),
    );
    const shadowedWhole = carriers
      .filter((r) => colocated((r.provides as string).slice(2)))
      .map((r) => `${r.provides} — ${(r.tests ?? []).length} carried, all shadowed by one file`);
    expect(
      shadowedWhole,
      "a colocated test file shadows EVERY test its record carries, not just the matching one",
    ).toEqual([]);
    expect(carriers.length, "records carrying more than one test").toBeGreaterThanOrEqual(20);
  });
});


// ── A module that is STILL A FILE also carries tests, and only the file runs them ───────────────────
//
// (`fifteen-test-files-duplicate-a-carried-test`.) The guard at the top of this file deliberately skips
// a record whose module is still present — "not retired, nothing to preserve yet". That is true of the
// MODULE and false of the TEST, and the gap is the whole of that item's finding: 15 test files under
// `src/` are byte-identical to a test carried on a record, and for FOURTEEN of them the emitter can
// never materialize the carried copy. Two independent reasons, both in `crates/bsc-emit/src/plan.rs`:
//
//   collect_seeds  keys the seed map by `provides` and takes ONLY a specifier starting with `@/`.
//                  A record without one is never in the map, so its tests are unreachable — 7 of the 15.
//   plan_records   then SKIPS any spec whose module file is still under `src/` ("the file is still
//                  there and authoritative"), which takes the carried tests with it — the other 7.
//
// So a record in either state holds assertions that execute from exactly ONE place: the colocated file.
// Deleting it because it "duplicates the record" runs those assertions nowhere, on a green gate — this
// repo's signature failure, and precisely the mistake a by-content duplicate census invites.
//
// Each arm asserts its own POPULATION, because "no record is in this state" and "the scan quietly
// stopped matching" are indistinguishable from a passing result.
describe("a carried test the emitter can never emit still needs its colocated file", () => {
  /** Every packaged algorithm implementation, beside the component records globbed above. */
  const impls = allImpls;

  const TEST_EXT = [".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx"];
  /** Is a colocated test running this module?
   *
   *  TWO SHAPES, and the second was found by this guard rather than reasoned out. The flat one is
   *  `x/y.ts` beside `x/y.test.ts`. The other is a BARREL: `@/shared/ui/charts` resolves through
   *  `shared/ui/charts/index.ts`, and its colocated test is `shared/ui/charts/charts.test.tsx` —
   *  named for the DIRECTORY, not for `index`. A flat-only check calls that record untested and
   *  reports a gap that is not there, so a barrel accepts any test sitting directly inside it.
   *  (docs/records.md, "A barrel is addressed THREE ways".) */
  const IN_DIR = /^[^/]+\.(?:test|spec)\.tsx?$/;
  const hasTestFile = (base: string) =>
    TEST_EXT.some((e) => srcFiles.has(base + e)) ||
    [...srcFiles].some((f) => f.startsWith(base + "/") && IN_DIR.test(f.slice(base.length + 1)));
  const carriedAssertions = (rec: { tests?: { src?: string }[] }) =>
    (rec.tests ?? []).reduce((n, t) => n + countAssertions(t.src ?? ""), 0);

  it("a record whose MODULE is still a file keeps its colocated test — the record's copy is not emitted", () => {
    const gaps: string[] = [];
    let checked = 0;
    for (const rec of [...Object.values(seeds), ...(impls ?? [])]) {
      const spec = typeof rec?.provides === "string" ? rec.provides.trim() : "";
      if (!spec.startsWith("@/") || !isOwnSpecifier(spec)) continue;
      const base = spec.slice(2);
      if (!hasFile(base)) continue; // retired — the guard at the top of this file owns it
      const carried = carriedAssertions(rec);
      if (!carried) continue;
      checked++;
      if (!hasTestFile(base)) gaps.push(`${spec} — ${carried} assertion(s) stored, and no file runs them`);
    }
    expect(
      gaps,
      `these records carry tests that NOTHING executes. The module is still a file, so ` +
        `\`plan_records\` skips the record and its carried copy is never emitted — the colocated test ` +
        `file is the only executor there is:\n  ${gaps.join("\n  ")}`,
    ).toEqual([]);
    expect(checked, "the guard examined at least one still-a-file record carrying tests").toBeGreaterThan(0);
  });

  it("a record with NO `@/` provides keeps its colocated test — `collect_seeds` never keys it at all", () => {
    const gaps: string[] = [];
    let checked = 0;
    for (const rec of [...Object.values(seeds), ...(impls ?? [])]) {
      const spec = typeof rec?.provides === "string" ? rec.provides.trim() : "";
      if (spec.startsWith("@/")) continue; // the arm above
      const from = typeof rec?.src === "string" ? rec.src.trim() : "";
      if (!from.startsWith("src/")) continue; // no provenance under src/ — no position to check
      const base = from.slice("src/".length).replace(/\.(tsx?|jsx?)$/, "");
      if (!hasFile(base)) continue; // the provenance file is gone; nothing colocated is expressible
      const carried = carriedAssertions(rec);
      if (!carried) continue;
      checked++;
      if (!hasTestFile(base)) {
        gaps.push(`${rec.id ?? from} — ${carried} assertion(s) stored, and no file runs them`);
      }
    }
    expect(
      gaps,
      `these records carry tests that NOTHING executes. Without an \`@/\` specifier \`collect_seeds\` ` +
        `never puts the record in the seed map, so the emitter cannot materialize its test at any ` +
        `point — the colocated file is the only executor there is:\n  ${gaps.join("\n  ")}`,
    ).toEqual([]);
    expect(checked, "the guard examined at least one provides-less record carrying tests").toBeGreaterThan(0);
  });
});


// ── A MIGRATED NODE TEST'S FILE MAY NOT COME BACK EITHER (`…-tranche-two`) ──────────────────────────
//
// The edge arm above has `edgeShadowed` to read, because an edge names the `src` file it was migrated
// out of. A NODE test carries no such provenance — `tests: [{ name, ext, src }]` and nothing more — so
// "this record's test used to be a file" is not a question the store can answer, and `plan.shadowed`
// only sees a file sitting at the record's OWN specifier (`SpectrumAnalyzer.test.tsx`), never one at
// the name it actually had (`nextTabName.test.ts` → `@/app/chrome/Tabstrip`).
//
// What IS mechanical is the content. A migration copies the file's bytes onto the record and deletes
// the file, so a file whose text is byte-identical to a test the emitter MATERIALIZES is that same
// test running twice — once from `src/`, once from `.bsc-records/` — with two copies free to drift.
// That is the failure records exist to remove, and it needs no hand-maintained list of what moved.
//
// ⚠️ RESTRICTED TO `plan.tests`, deliberately. `docs/records.md` records fifteen `src/` files that ARE
// byte-identical to a carried test and MUST keep their file, because `collect_seeds`/`plan_records`
// can never materialize the record's copy. Those are not in `plan.tests`, so they are not duplicates
// in the sense that matters: nothing else runs them.
describe("a migrated node test's file has not come back", () => {
  /** Every test file under `src/`, as raw text. */
  const srcTests = import.meta.glob<string>("/src/**/*.{test,spec}.{ts,tsx}", {
    eager: true,
    query: "?raw",
    import: "default",
  });

  it("no file under src/ duplicates a carried test the emitter materializes — that is two live copies", () => {
    const plan = planRecords();
    const byText = new Map<string, string>();
    for (const t of plan.tests as { spec: string; rel: string; src: string }[]) {
      byText.set(t.src, `${t.spec} → .bsc-records/${t.rel}`);
    }
    const dupes: string[] = [];
    for (const [path, text] of Object.entries(srcTests)) {
      const where = byText.get(text);
      if (where) dupes.push(`${path.replace(/^\//, "")} is byte-identical to ${where}`);
    }
    expect(
      dupes,
      "these files were migrated onto a record and have come back. The record's copy is emitted into " +
        "`.bsc-records/` and runs there, so the file is a SECOND live copy of the same assertions — " +
        "delete it, or drop the carried test, but not both:\n  " + dupes.join("\n  "),
    ).toEqual([]);
    // Non-vacuity, both sides: a glob that stopped matching and a plan with no emitted tests each look
    // exactly like a clean sweep from here.
    expect(Object.keys(srcTests).length, "test files scanned under src/").toBeGreaterThan(100);
    expect(byText.size, "carried tests the emitter materializes").toBeGreaterThan(100);
  });

  // ── AND IT MAY NOT SILENTLY CHANGE ENVIRONMENT ──────────────────────────────────────────────────
  //
  // `bsc-emit` re-addresses a node test to its RECORD's path, so a test written under jsdom can land
  // under `**/lib/**` — which `vitest.config.ts` gives to the `node` project. That is the whole reason
  // the migration rule says a node test moves only when the record keeps it on the same side of the
  // boundary. The hazard is not the move; it is the move being SILENT.
  //
  // `vitest.config.ts` already documents the cure — "a file that genuinely needs a DOM despite living
  // under `lib/` says so ITSELF, with a `@vitest-environment jsdom` docblock, which takes precedence
  // over the project's environment" — so this makes that the enforced form: a materialized test that
  // lands in `node` and reaches for a DOM must DECLARE it. An edge test needs no such arm, because
  // `bsc-emit` writes an edge back at its original relative path and its project cannot change.
  it("a carried test emitted into the `node` project either needs no DOM, or declares jsdom", () => {
    // The `node` project's include, restated: `.bsc-records/**/lib/**/*.test.{ts,tsx}`.
    const NODE_PROJECT = /(^|\/)lib\//;
    // A DOM reach that would throw (or quietly assert nothing) with `environment: "node"`.
    const NEEDS_DOM = /@testing-library\/|\bdocument\.|\bwindow\.|\bscreen\.|[^\w.]render\(/;
    const DECLARES = /@vitest-environment\s+jsdom\b/;
    const undeclared: string[] = [];
    let inNode = 0;
    for (const t of planRecords().tests as { spec: string; rel: string; src: string }[]) {
      if (!NODE_PROJECT.test(t.rel)) continue;
      inNode++;
      // SCAN A COMMENT-BLANKED COPY. Prose about a rule trips the rule — `docs/records.md` records
      // four scanners caught by it in one day, and this one made five: `roleModel.test.ts` says
      // "contradictory instructions in one context window." and `\bwindow\.` matched the full stop.
      // The DECLARATION is read from the original, because a docblock IS a comment.
      if (NEEDS_DOM.test(blankComments(t.src)) && !DECLARES.test(t.src)) {
        undeclared.push(`${t.spec} → .bsc-records/${t.rel} reaches for a DOM the \`node\` project has not got`);
      }
    }
    expect(
      undeclared,
      "these carried tests are materialized under `lib/`, which the `node` project claims, and they " +
        "touch the DOM. Put `// @vitest-environment jsdom` at the top of the test (the mechanism " +
        "`vitest.config.ts` documents), or move the test to a record on the other side of the " +
        "boundary:\n  " + undeclared.join("\n  "),
    ).toEqual([]);
    expect(inNode, "carried tests materialized into the `node` project").toBeGreaterThan(50);
  });
});
