// The shared/ ↔ app/-and-features/ boundary, extended to RECORDS (#1626/#1703 — request #181).
//
// `eslint.config.js` forbids a `src/shared/**/*.{ts,tsx}` FILE from importing a VALUE out of `features/`
// or `app/` — shared/ has to stay feature- and app-agnostic. But the same config file also ignores
// `.bsc-records/**` (#3392: it's a GENERATED tree, rebuilt from the seed on every build, and linting it
// reports every real finding twice). So the rule is enforced over exactly the half of the frontend that
// is still FILES, and is silent over the ~1,005 modules that ship as records (docs/records.md) — which
// is most of the app now. The coverage shrank as the migration succeeded, and nothing announced it.
//
// CONFIRMED (maintainer, 2026-08-29): `.bsc-records/shared/lib/fleet/useWorkerAutoEnd.tsx` imported the
// VALUE `paneIdFor` from `@/app/console/lib/paneIdentity` — exactly what #1626 forbids — and no gate
// caught it. `useWorkerAutoEnd` is an ALGORITHM record (`data/knowledge/algorithms.json`); a records-blind
// guard covering only `data/components/app/**` would still have missed it.
//
// WHY THIS LIVES IN VITEST, NOT ESLINT. eslint parses FILES on disk; a record's source is a STRING field
// in a checked-in JSON seed until `emit-records.mjs` materializes it, and `.bsc-records/` is generated +
// git-ignored (fixing a finding there is undone by the next build). `platformBoundary.test.ts` already
// reads that same string field to ask a different question (do this record's imports resolve) —
// `recordImports.test.ts` reads it for a third (is a specifier relative) — so a vitest guard reading
// record source directly is proven, not novel: it is the working precedent for a records-aware question,
// applied to a fourth one.
//
// Reads the SEED (`data/components/app/**`, `data/knowledge/algorithms.json`), never the runtime store —
// same reasoning as both precedents: the seed is what ships, and the guard has to hold on a fresh clone
// and in CI where no local store exists.
import { describe, it, expect } from "vitest";
import algorithmsSeed from "@data/knowledge/algorithms.json";
// A relative path on purpose: `scripts/` is outside the `@/` alias (which maps to `src/`).
import { runtimeImports } from "../../../scripts/lib/recordSource.mjs";

interface SeedRecord {
  id: string;
  provides?: string;
  srcText?: string;
  suppressed?: boolean;
}

const seedModules = import.meta.glob<{ default: SeedRecord }>("@data/components/app/**/*.json", { eager: true });
const COMPONENTS: SeedRecord[] = Object.values(seedModules)
  .map((m) => m.default)
  .filter((r) => r && r.id && r.suppressed !== true);

const IMPLS = ((algorithmsSeed as { implementations?: { id: string; tech?: string; provides?: string; code?: string; suppressed?: boolean }[] }).implementations ?? [])
  .filter((i) => i.tech === "typescript" && i.code && i.suppressed !== true);

/** A record whose `provides` places it under `shared/` — the specifier-side mirror of eslint's
 *  `files: ["src/shared/**"]`. Bare `code`/`srcText` — comments blanked by `runtimeImports` itself —
 *  is read for BOTH surfaces, since a component's `srcText` and an implementation's `code` are the same
 *  kind of thing: the module body a record answers `provides` with. */
function sharedRecords<T extends { provides?: string }>(records: T[]): T[] {
  return records.filter((r) => r.provides?.startsWith("@/shared/"));
}

/** Mirrors the eslint shared/-boundary rule's forbidden `group` (#1626/#1703): a VALUE import reaching
 *  into `features/` or `app/`. `runtimeImports` already excludes whole-statement `import type` — a mixed
 *  `import { type A, B }` still counts, exactly as `allowTypeImports` does for the eslint rule — so
 *  `import type` stays allowed here too, matching the file-side rule rather than inventing a stricter
 *  one. */
const crossesBoundary = (spec: string) => spec.startsWith("@/features/") || spec.startsWith("@/app/");

/** Whether an inline eslint-disable comment already waives `spec`'s import in `text` — the same waiver
 *  the file-side rule honors, so a documented exception doesn't fail a records-aware guard eslint itself
 *  leaves alone. `conformance.ts` (`@/shared/lib/fleet/conformance`) carries exactly one: a single
 *  scoped `@typescript-eslint/no-restricted-imports` disable, with its rationale in the line above it,
 *  on `@/features/planner/fleet/flowPermissions` — the "single deliberate exception" eslint.config.js's
 *  own comment names. Mirrors eslint's placement rule: `eslint-disable-next-line` on the line ABOVE the
 *  import, or `eslint-disable-line` on the SAME line. */
function isWaived(text: string, spec: string): boolean {
  const specLine = new RegExp(`from\\s*["']${spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`);
  const lines = text.split("\n");
  return lines.some(
    (line, i) => specLine.test(line) && (/eslint-disable-next-line/.test(lines[i - 1] ?? "") || /eslint-disable-line/.test(line)),
  );
}

describe("the shared/ boundary holds for records too (#1626/#1703, request #181)", () => {
  it("has records to check — neither surface has gone vacuous", () => {
    // Non-vacuity: if either glob stops matching, the assertion below passes while checking nothing —
    // the exact failure class this guard exists to close.
    expect(COMPONENTS.length).toBeGreaterThan(300);
    expect(IMPLS.length).toBeGreaterThan(400);
  });

  it("no shared/ record imports a VALUE from features/ or app/", () => {
    const shared = [
      ...sharedRecords(COMPONENTS).map((r) => ({ id: r.id, provides: r.provides!, text: r.srcText ?? "" })),
      ...sharedRecords(IMPLS).map((i) => ({ id: i.id, provides: i.provides!, text: i.code ?? "" })),
    ];
    // Same non-vacuity concern as above, scoped to the slice this test actually walks: if nothing under
    // `@/shared/` were found, the loop below would pass having checked zero records.
    expect(shared.length).toBeGreaterThan(50);

    const violations = shared.flatMap(({ id, provides, text }) =>
      runtimeImports(text)
        .filter((spec) => crossesBoundary(spec) && !isWaived(text, spec))
        .map((spec) => `${id} (${provides}) → ${spec}`),
    );
    expect(violations, `shared/ records importing app/ or features/ as a VALUE (#1626/#1703):\n  ${violations.join("\n  ")}`).toEqual([]);
  });
});
