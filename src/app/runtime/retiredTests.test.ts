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
import { planRecords, edgeTestPath } from "../../../scripts/emit-records.mjs";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Every packaged seed, as the record objects the app would load. */
const seeds = import.meta.glob<{ id?: string; provides?: string; tests?: { name?: string; src?: string }[] }>(
  "@data/components/app/**/*.json",
  { eager: true, import: "default" },
);

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
    const plan = planRecords();
    for (const t of plan.tests) {
      expect(t.src, `${t.spec} carries no unrewritten relative import`).not.toMatch(
        /(?:from|import|vi\.mock|require)\s*\(?\s*["']\.{1,2}(?:\/|["'])/,
      );
    }
  });
});


// ── EDGES (integration-tests-become-graph-edges) ────────────────────────────────────────────────────
//
// The node twin above exists because "deleting a colocated test trades executed coverage for stored
// coverage behind a green gate" — it cost 31 assertions before anything checked. The edge tier is the
// same trade with the same shape, and it shipped with a STORE and a CLI and nothing that runs a test,
// so these assert the executing half before 51 cross-module tests are moved onto it.
describe("an edge test is executed, not merely stored", () => {
  it("emits an edge's tests at the mirror of the file it came from — so a lib/ test keeps `node`", () => {
    // NOT vacuous at zero edges: this exercises the rule directly rather than iterating a set that is
    // currently empty. A synthetic folder for every edge would be the tempting alternative and would
    // re-classify every pure-domain integration test into jsdom, which the `node` project selects
    // against by path (`src/**/lib/**`) and costs 488.56s of environment for 13.93s of tests.
    expect(edgeTestPath("src/shared/lib/security/roleProfileConsistency.test.ts", 0, ".ts", "")).toBe(
      "shared/lib/security/roleProfileConsistency.test.ts",
    );
    expect(edgeTestPath("src/shared/ui/overlay/modalFocus.test.tsx", 0, ".tsx", "")).toBe(
      "shared/ui/overlay/modalFocus.test.tsx",
    );
    // A second test on one edge gets its own file rather than overwriting the first — `roleModel ×
    // sessionRoles` already attracts two (funnelTiers + sessionRoles.roleTable).
    expect(edgeTestPath("src/a/b.test.ts", 1, ".ts", "")).toBe("a/b.1.test.ts");
    // The carried extension wins over the body guess, for the reason the node path learned it: a
    // generic arrow named `.tsx` fails to parse and reports as a dead suite.
    expect(edgeTestPath("src/a/b.test.ts", 0, undefined, "const f = <T>(x: T) => x;")).toBe("a/b.test.tsx");
    expect(edgeTestPath("src/a/b.test.ts", 0, ".ts", "const f = <T>(x: T) => x;")).toBe("a/b.test.ts");
  });

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
});
