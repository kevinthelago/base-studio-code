// A record may not import RELATIVELY — the guard, over every packaged record source
// (records-carry-relative-imports-that-break-when-a-neighbour-retires).
//
// THE RULE. A record is resolved by the runtime loader against the platform registry and the record
// store, never against a directory. `makeRequire` routes a specifier to the registry under its LITERAL
// key, so `./useDockBack` needs a registration exactly like an absolute one, and `provides` — which
// matches on the exact specifier — can never reach it. A relative specifier in a record therefore only
// ever *appeared* to work, and only for as long as the neighbour was still a FILE that a bundler could
// resolve. Retiring that neighbour arms the trap.
//
// WHY A SECOND GUARD, when `platformBoundary.test.ts` already rejects a relative specifier. That one
// checks a record's imports RESOLVE, and it reads exactly one surface to do it: seed COMPONENTS, via
// `runtimeImports`, which sees only `from "…"` statements. Measured across the whole library, three
// surfaces sat outside it:
//
//   * algorithm IMPLEMENTATION records (`algorithms.json`) — never scanned at all;
//   * the INLINE import forms — `import("../fleet/workerScope").WorkerUiPairing` in type position, a
//     dynamic `import("./vizProgram")`. `projectPaneInput` carried three of the first kind, and a
//     `from "…"` sweep is documented to leave exactly them behind;
//   * the live STORE, which is what the running app renders from — 57 relative specifiers across 25
//     records, while the seed was clean and every gate was green.
//
// The store is deliberately NOT checked here: this guard has to hold on a fresh clone and in CI where
// no local store exists. `node scripts/check-record-imports.mjs` is the store's half, and `--fix`
// repairs it.
//
// CARRIED TESTS ARE THE ONE EXEMPTION, and it is deliberate rather than an oversight. A test is
// harvested beside its module saying `./LabelChip`, and `emit-records.mjs` both REWRITES that to `@/…`
// on emit and USES it to verify the pairing (a record carrying a test for something else is rejected by
// exactly this check). So the relative form is load-bearing at rest; what must hold is that nothing
// relative survives into the emitted tree, which is asserted below.
import { describe, it, expect } from "vitest";
import algorithmsSeed from "@data/knowledge/algorithms.json";
import { planRecords } from "../../../scripts/emit-records.mjs";
// A relative path on purpose: `scripts/` is outside the `@/` alias (which maps to `src/`).
import { relativeSpecifiers } from "../../../scripts/lib/recordSource.mjs";

interface SeedRecord {
  id: string;
  src?: string;
  srcText?: string;
  provides?: string;
  suppressed?: boolean;
}

const seedModules = import.meta.glob<{ default: SeedRecord }>("@data/components/app/**/*.json", { eager: true });
const COMPONENTS: SeedRecord[] = Object.values(seedModules)
  .map((m) => m.default)
  .filter((r) => r && r.id && r.suppressed !== true);

const IMPLS = ((algorithmsSeed as { implementations?: { id: string; tech?: string; code?: string }[] }).implementations ?? [])
  .filter((i) => i.tech === "typescript" && i.code);

/** `id → spec` for every relative specifier in `sources`. */
const offenders = (sources: { id: string; text: string }[]) =>
  sources.flatMap(({ id, text }) =>
    (relativeSpecifiers(text) as { spec: string }[]).map(({ spec }) => `${id} → ${spec}`),
  );

describe("a record may not import relatively", () => {
  it("has both surfaces to check — neither glob has gone vacuous", () => {
    // Without this, a glob that stops matching turns both assertions below into green nothing — the
    // failure mode this repo keeps paying for.
    expect(COMPONENTS.length).toBeGreaterThan(300);
    expect(IMPLS.length).toBeGreaterThan(400);
  });

  it("no packaged COMPONENT record's source carries a relative specifier", () => {
    const bad = offenders(COMPONENTS.map((r) => ({ id: r.id, text: r.srcText ?? "" })));
    expect(bad, `records must import absolutely:\n  ${bad.join("\n  ")}`).toEqual([]);
  });

  it("no packaged IMPLEMENTATION record's code carries a relative specifier", () => {
    // The half `platformBoundary.test.ts` never read. `classifyConfig` and `pageBinding` both look like
    // violations to a comment-blind scan and are not: the specifier is inside a doc comment explaining
    // the loader, which is why `relativeSpecifiers` is line-anchored rather than a bare regex.
    const bad = offenders(IMPLS.map((i) => ({ id: i.id, text: i.code ?? "" })));
    expect(bad, `records must import absolutely:\n  ${bad.join("\n  ")}`).toEqual([]);
  });

  it("no carried test reaches the EMITTED tree still relative", () => {
    // The exemption's other half. A carried test may hold `./LabelChip` at rest — that is how the
    // emitter verifies it is paired with the right module — but the copy that vitest runs must resolve
    // through `@/…`, or it reaches nothing once the sibling stops being a file.
    const { tests } = planRecords() as { tests: { path: string; src: string }[] };
    expect(tests.length).toBeGreaterThan(0);
    const bad = offenders(tests.map((t) => ({ id: t.path, text: t.src })));
    expect(bad, `emitted tests must import absolutely:\n  ${bad.join("\n  ")}`).toEqual([]);
  });
});
