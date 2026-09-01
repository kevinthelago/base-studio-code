// The FOURTH import scanner, now AGREEING with the canonical one — and pinned there.
//
// HISTORY, because this file's job changed and the reason matters. `importScan.fixtures.gen.test.ts`
// records that this repo ran THREE import scanners which disagreed on 7 of 11 cases first measured, two
// of them on live paths, and `crates/bsc-ui/src/import_scan.rs` is the tree-sitter answer proved right
// against that corpus. `scripts/lib/recordSource.mjs`'s `runtimeImports` was a fourth — a line-anchored
// regex — and nothing had measured it. When first measured it agreed on 27 of 31 subjects and diverged
// in two ways, and this file PINNED those divergences rather than fixing them, because `runtimeImports`
// is what two gate guards read and changing it is a decision, not a refactor.
//
// That decision was taken (maintainer, 2026-09-01): adopt the canonical answer. Both divergences are now
// CLOSED, and the two that were:
//
//   OVER-REPORTED an all-inline-type clause. `import { type A, type B }` erases at compile time and emits
//   no require, but the `(?!type\s)` guard only caught a STATEMENT-level `import type`. That is the exact
//   mistake `platformBoundary.test.ts` was written to correct — #3858 measured the boundary as broken and
//   the guard showed it a false alarm, because the analysis counted type-only imports as runtime deps.
//   The guard fixed the statement form and left the inline form carrying it.
//
//   UNDER-REPORTED a bare side-effect import. `import "./a.css"` is a real require the regex could not see
//   because it demanded a `from` clause — a guard MISSING a dependency, the direction that actually hurts.
//
// A MIXED clause still counts, and must keep counting: `import { type A, b }` really does require the
// module for `b`, and `recordBoundary.test.ts` documents that as matching the eslint rule's
// `allowTypeImports` — "the file-side rule rather than inventing a stricter one".
//
// The subjects are READ from the canonical fixture, never copied. A second copy of the corpus would drift
// from the first, which is the whole failure this family of tests exists to prevent.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeImports } from "../../../../../scripts/lib/recordSource.mjs";

const FIXTURE = join(process.cwd(), "src/shared/lib/runtime/shadow/importScan.fixtures.json");

interface Case { label: string; source: string; imports: Array<{ specifier: string }> }

const CASES: Case[] = JSON.parse(readFileSync(FIXTURE, "utf8")).cases;

const canonical = (c: Case) => [...new Set(c.imports.map((i) => i.specifier))].sort();
const fourth = (c: Case) => [...(runtimeImports(c.source) as string[])].sort();

describe("recordSource's runtimeImports vs the canonical import scan", () => {
  it("is measuring a real corpus, not an empty one", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(30);
    // Both directions must survive a regeneration: a corpus of only-imports proves a scanner sees
    // things, and a corpus of only-non-imports proves it refuses them. Neither alone proves it is right.
    expect(CASES.filter((c) => c.imports.length > 0).length).toBeGreaterThanOrEqual(20);
    expect(CASES.filter((c) => c.imports.length === 0).length).toBeGreaterThanOrEqual(5);
  });

  it("agrees with the canonical scanner on EVERY subject", () => {
    const disagreements = CASES.filter(
      (c) => JSON.stringify(canonical(c)) !== JSON.stringify(fourth(c)),
    ).map((c) => ({ label: c.label, canonical: canonical(c), recordSource: fourth(c) }));
    expect(disagreements, "the two scanners have drifted apart again").toEqual([]);
  });

  it("keeps the two formerly-divergent cases answered the canonical way", () => {
    // Named explicitly rather than left to the sweep above, so a corpus that loses these subjects fails
    // loudly instead of quietly dropping the only coverage of the behaviour that was corrected.
    const byLabel = new Map(CASES.map((c) => [c.label, c]));

    const inlineType = byLabel.get("an all-inline-type clause is erased too");
    expect(inlineType, "the over-report subject left the corpus").toBeDefined();
    expect(fourth(inlineType!), "an all-type clause emits no require").toEqual([]);

    const bare = byLabel.get("a bare side-effect import");
    expect(bare, "the under-report subject left the corpus").toBeDefined();
    expect(fourth(bare!), "a bare import IS a runtime require").toEqual(["./a.css"]);
  });

  it("still counts a MIXED clause — the case that must NOT have been corrected", () => {
    // `recordBoundary.test.ts` relies on this: a mixed clause requires the module for its value binding,
    // and the guard matches eslint's `allowTypeImports` rather than inventing a stricter rule. Correcting
    // the all-type case must not have taken this with it.
    const mixed = CASES.find((c) => c.label === "ONE value binding keeps the whole import");
    expect(mixed, "the mixed-clause subject left the corpus").toBeDefined();
    expect(fourth(mixed!)).toEqual(["./ab"]);
    expect(canonical(mixed!)).toEqual(["./ab"]);
  });
});
