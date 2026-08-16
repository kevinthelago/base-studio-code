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
