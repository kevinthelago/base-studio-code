// What `planRecords` will and will not turn into a runnable test file (#record-tests-execute-in-the-gate).
//
// A record's carried tests become real files under `.bsc-records/`, which is what lets a retired module
// drop its colocated `*.test.tsx` without dropping its coverage. That makes the PLAN the safety boundary:
// anything it emits runs in the default gate, and anything it declines has to be visibly declined rather
// than quietly absent.
//
// Lives under `scripts/` for the same reason `emitOnce.test.ts` does — it imports the emitter directly,
// and the emitter is not under the `src/` tsconfig include.
import { describe, it, expect } from "vitest";

// A relative import, deliberately: `@/…` maps to `src/`, and this module is not under it.
const { planRecords } = await import("../scripts/emit-records.mjs");

const plan = planRecords();

describe("carried tests are verified, not trusted (#record-tests-execute-in-the-gate)", () => {
  it("declines a MISPAIRED test instead of emitting a broken import", () => {
    // `bsc ui harvest` attached whatever colocated test it found, so the seed holds records paired with a
    // test for something else: `@/components/typechip` carries the `ScanViews` test, and four separate
    // records all carry the one `bodyStyles` test. Emitting those verbatim put 15 unresolvable imports
    // into the gate the first time this ran. `harvest-pairs-only-an-isolated-test` fixed the harvester;
    // it did not clean the records the old one had already written, so the emitter has to hold the line.
    expect(plan.unresolvable.length, "the known mispairs are still being declined").toBeGreaterThan(0);
    for (const u of plan.unresolvable) {
      // Declined is not enough — it has to SAY WHY, or "has no test" and "has a test that cannot run"
      // are indistinguishable from outside.
      expect(u.missing.length, `${u.spec} names the import that disqualified it`).toBeGreaterThan(0);
      expect(u.detail).toContain("cannot resolve");
    }
  });

  it("never emits a test whose subject a src/ file still tests — the assertions would run twice", () => {
    const emitted = new Set(plan.tests.map((t: { spec: string }) => t.spec));
    for (const spec of plan.shadowed) {
      expect(emitted.has(spec), `${spec} is shadowed by a colocated file, so it must not ALSO be emitted`).toBe(
        false,
      );
    }
  });

  it("emits nothing twice — one file per carried test", () => {
    const paths = plan.tests.map((t: { rel: string }) => t.rel);
    expect(new Set(paths).size, "every emitted test has a distinct path").toBe(paths.length);
  });

  it("a declined test is never also an emitted one", () => {
    // The three buckets partition the carried tests; an overlap would mean a record both ran and did not.
    const emitted = new Set(plan.tests.map((t: { spec: string }) => t.spec));
    for (const u of plan.unresolvable) expect(emitted.has(u.spec)).toBe(false);
  });
});

// ── the carried extension (#algorithm-tests-live-on-their-records) ──────────────────────────────────
describe("a carried test keeps the extension its source had", () => {
  it("obeys a record's own `ext` instead of guessing from the source", () => {
    // `extFor` treats any `<Word…>` as JSX, so `const last = <T>(a: readonly T[]): T => …` — an
    // ordinary generic arrow, and test files are full of them — gets named `.tsx`. The parser then
    // reads `<T>` as a JSX tag and the whole suite fails to transform. Measured at 177 of 376 files on
    // the algorithm corpus: the guess is wrong about HALF the time there.
    //
    // So a record that knows its source extension states it, and this asserts the emitter obeys that
    // rather than re-deriving it. Records predating the field still fall back to `extFor`, which is why
    // this only checks the entries that carry one.
    const carried = plan.tests.filter((t: { ext?: string }) => typeof t.ext === "string");
    for (const t of carried as { spec: string; ext: string; rel: string }[]) {
      expect(t.rel.endsWith(t.ext), `${t.spec} emitted as ${t.rel}, but its record carries ${t.ext}`).toBe(true);
    }
  });

  it("emits a parseable file for every carried test — the failure this prevents is a TRANSFORM error", () => {
    // A misnamed `.tsx` does not fail an assertion, it fails to COMPILE, which reports as a dead suite
    // rather than a red test. Cheap structural proxy: a file emitted `.tsx` whose source has a generic
    // arrow and no JSX element is the exact shape that breaks.
    const suspicious = plan.tests.filter(
      (t: { rel: string; src: string }) =>
        t.rel.endsWith(".test.tsx") && /=\s*<[A-Z]\w*>\(/.test(t.src) && !/<[A-Z]\w*[\s/>]/.test(t.src.replace(/=\s*<[A-Z]\w*>\(/g, "")),
    );
    expect(suspicious.map((t: { spec: string }) => t.spec), "a generic arrow must not land in a .tsx").toEqual([]);
  });
});

// ── a colocated ASSET is reachable (#a-carried-test-cannot-import-a-colocated-json-fixture) ─────────
describe("a carried test may read a colocated fixture", () => {
  it("emits a test that imports a `.json` asset instead of declining it", () => {
    // `reachable()` only tried module extensions, so `./projectSlug.fixtures.json` — an exact filename —
    // matched nothing and its carried test was declined as unresolvable, on a green gate. That is the
    // documented reason `ecbd2402` held `projectPaths` and `tunnel` back: "a test importing a COLOCATED
    // NON-MODULE ASSET cannot move, because the asset does not".
    //
    // The asset does not move. It stays under `src/` and the emitted copy reaches it through the same
    // `@/…` alias every module specifier uses, so there is still exactly ONE fixture file — which is what
    // keeps the Rust `find_fixture` name search (it panics on a second match under `src/`) untouched.
    const withAsset = plan.tests.filter((t: { src: string }) => /from\s+["']@\/[^"']+\.json["']/.test(t.src));
    expect(withAsset.length, "no carried test reads a .json fixture — this guard has nothing to prove").toBeGreaterThan(0);
  });

  it("never declines a test for an asset import", () => {
    // The failure mode is silence: a declined test is simply absent from the gate, and the record still
    // reads as "has a test". So assert on the DECLINED bucket directly rather than only on the emitted one.
    const assetDeclines = plan.unresolvable.filter((u: { missing: string[] }) =>
      u.missing.some((m) => /\.[A-Za-z][A-Za-z0-9]*$/.test(m) && !/\.(tsx?|jsx?)$/.test(m)),
    );
    expect(assetDeclines.map((u: { detail: string }) => u.detail), "an asset import must not disqualify a carried test").toEqual([]);
  });

  it("still declines a specifier that names nothing at all", () => {
    // The asset arm is an `existsSync` fallback, checked LAST. It must not turn every unresolvable
    // specifier into a pass — the mispairs above are the proof that declining still happens.
    expect(plan.unresolvable.length, "the known mispairs are still declined").toBeGreaterThan(0);
  });
});
