// A PAGE record may not import a sibling by RECORD ID — the seed-side guard.
//
// THE RULE. `@/components/<id>` is resolved by the runtime graph loader against the record store. It is
// not a path, so a record carrying it cannot be materialized into `.bsc-records/` and imported by the
// bundle — which means the page's `.tsx` can never be retired, and if it is retired anyway the build
// dies with "Cannot find package '@/components/…'". Four page files were retired past that constraint
// with typecheck, lint, clippy, nextest and the rest of vitest all green; only
// `platformModules.gen.test.ts` noticed.
//
// WHY THIS GUARD IS SEED-SIDE, and why it REPLACES a record-vs-file one. `glancepageRecord.gen.test.ts`
// asserted the projection emitted the right sibling form, which only ever covered ONE page and only for
// as long as that page had a file to project FROM. The maintainer's direction (2026-08-18) is that
// parity is measured between SEED records, never against a `.tsx` — so the check moves here, where it
// reads the packaged seed and covers every page at once.
import { describe, expect, it } from "vitest";

/** Every packaged component record, eagerly — the seed is what ships. */
const SEED = import.meta.glob("@data/components/app/**/*.json", { eager: true }) as Record<
  string,
  { default: { id?: string; role?: string; srcText?: string } }
>;

/** Sibling imports written in the loader-only form. */
const siblingIds = (src: string): string[] =>
  [...new Set([...src.matchAll(/from\s*["'`]@\/components\/([A-Za-z0-9._-]+)["'`]/g)].map((m) => m[1]))];

/**
 * The ONE page still on the old form, named so it is a visible exception rather than a silent one.
 *
 * `securitypage` imports `@/components/security-flow`. Giving that record a real specifier makes
 * `emit-records` materialize its CARRIED TESTS, which then execute for the first time and fail: they
 * render a barrel export the records cleanup removed, and their assertions were written against the
 * whole-workspace render rather than the tab. Rewriting assertions to match observed output is how a
 * test stops being a test, so it is tracked as `security-flow-carried-tests-are-stale` instead.
 *
 * Shrinking this list is the work. Growing it needs a reason as specific as this one.
 */
const KNOWN_LOADER_ONLY: Record<string, string[]> = {
  securitypage: ["security-flow"],
};

describe("a page record imports siblings by SPECIFIER, not by record id", () => {
  const pages = Object.values(SEED)
    .map((m) => m.default)
    .filter((r): r is { id: string; role: string; srcText: string } =>
      Boolean(r?.id && r.role === "page" && typeof r.srcText === "string"),
    );

  it("finds page records to check — a glob that silently matched nothing would pass vacuously", () => {
    expect(pages.length).toBeGreaterThan(10);
  });

  it("no page record imports `@/components/<id>` except the ones named above", () => {
    const offending: string[] = [];
    for (const page of pages) {
      const allowed = KNOWN_LOADER_ONLY[page.id] ?? [];
      for (const id of siblingIds(page.srcText)) {
        if (!allowed.includes(id)) offending.push(`${page.id} → @/components/${id}`);
      }
    }
    expect(
      offending,
      "these are resolvable ONLY by the runtime graph loader, so the record cannot be materialized into " +
        "`.bsc-records/` and the page's file can never be retired:\n  " + offending.join("\n  "),
    ).toEqual([]);
  });

  it("every named exception is REAL — a stale entry here would hide a regression", () => {
    // If the exception is fixed and the list is not, the next page to regress inherits a free pass.
    const stale: string[] = [];
    for (const [pageId, ids] of Object.entries(KNOWN_LOADER_ONLY)) {
      const page = pages.find((p) => p.id === pageId);
      if (!page) { stale.push(`${pageId}: no such page record`); continue; }
      const actual = siblingIds(page.srcText);
      for (const id of ids) if (!actual.includes(id)) stale.push(`${pageId} → ${id}: no longer imported, drop it from the list`);
    }
    expect(stale, `stale exceptions:\n  ${stale.join("\n  ")}`).toEqual([]);
  });
});
