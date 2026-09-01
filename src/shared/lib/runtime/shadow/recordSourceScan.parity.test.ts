// The FOURTH import scanner, measured against the canonical corpus.
//
// `importScan.fixtures.gen.test.ts` records that this repo ran THREE import scanners which disagreed on
// 7 of 11 cases first measured, two of them on live paths, and `crates/bsc-ui/src/import_scan.rs` is the
// tree-sitter answer proved right against that corpus. `scripts/lib/recordSource.mjs`'s `runtimeImports`
// is a fourth — a line-anchored regex over comment-stripped source — and nothing had ever measured it.
//
// It is not obscure. `emit-records.mjs` rides on the same module (7 npm entries, run before tsc and
// vitest), and TWO gate guards import `runtimeImports` directly: `platformBoundary.test.ts` and
// `recordBoundary.test.ts`.
//
// THIS FILE CHANGES NEITHER SCANNER. Changing one two gate guards depend on is a separate decision, and
// it should be taken against a fixture that states what the current answer IS — the same move
// `importScan.fixtures` already makes for the TypeScript's dynamic-import blindness, which it records
// with the wrong answer on purpose so the divergence lives in the artifact rather than in an
// implementation's private expectation.
//
// It is also the parity baseline the Rust port needs: when `recordSource` moves, this is what says the
// move preserved behaviour — including the two places that behaviour is wrong.
//
// The subjects are READ from the canonical fixture, never copied. A second copy of the corpus would
// drift from the first, which is the whole failure this family of tests exists to prevent.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeImports } from "../../../../../scripts/lib/recordSource.mjs";

const FIXTURE = join(process.cwd(), "src/shared/lib/runtime/shadow/importScan.fixtures.json");

interface Case { label: string; source: string; imports: Array<{ specifier: string }> }

const CASES: Case[] = JSON.parse(readFileSync(FIXTURE, "utf8")).cases;

/** The canonical scanner's specifiers for a case, deduped — `runtimeImports` dedupes, so compare like
 *  with like rather than reporting the same module twice as a disagreement. */
const canonical = (c: Case) => [...new Set(c.imports.map((i) => i.specifier))].sort();
const fourth = (c: Case) => [...(runtimeImports(c.source) as string[])].sort();

/** The cases where the two deliberately disagree, each with WHY and its measured blast radius. Listed
 *  by label so a corpus that grows does not silently widen the exemption. */
const DIVERGENT = new Map<string, string>([
  [
    "an all-inline-type clause is erased too",
    // OVER-REPORT. `import { type A, type B } from "./ab"` is erased before anything resolves, so the
    // canonical returns nothing. `runtimeImports` returns the specifier, because its `(?!type\s)` guard
    // only catches a STATEMENT-level `import type`. ELEVEN packaged algorithm records carry such a
    // clause today (blueprint-mcp.ts, blueprint-share.ts, blueprint-skills.ts, blueprint-types.ts,
    // mcp-context.ts and six more), so both boundary guards are strictly stricter than the runtime they
    // model — a record importing only TYPES from a module that is not a runtime platform module is
    // flagged for an import that does not exist at run time.
    "over-reports: an all-inline-type clause is erased at compile time",
  ],
  [
    "a bare side-effect import",
    // UNDER-REPORT, and the more dangerous shape. `import "./a.css"` is a real `require` at runtime; the
    // regex cannot see it because it demands a `from` clause. Blast radius TODAY is ZERO — no component
    // record and no algorithm impl carries one — so this is latent, and the day one does the boundary
    // guards will not see it.
    "under-reports: a bare side-effect import has no `from` clause",
  ],
  ["several imports keep source order", "under-reports: the bare `./c.css` in the same source"],
  ["a bare import BEFORE a named one", "under-reports: the bare `./a.css` in the same source"],
]);

describe("recordSource's runtimeImports vs the canonical import scan", () => {
  it("is measuring a real corpus, not an empty one", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(30);
    for (const label of DIVERGENT.keys()) {
      expect(CASES.some((c) => c.label === label), `${label} left the corpus`).toBe(true);
    }
  });

  it("agrees with the canonical scanner everywhere it is not knowingly divergent", () => {
    const surprises = CASES.filter((c) => !DIVERGENT.has(c.label))
      .filter((c) => JSON.stringify(canonical(c)) !== JSON.stringify(fourth(c)))
      .map((c) => ({ label: c.label, canonical: canonical(c), recordSource: fourth(c) }));
    expect(surprises, "a NEW disagreement — one scanner moved and the other did not").toEqual([]);
  });

  it("still diverges in exactly the two known ways, and no others", () => {
    // Pinned as EQUALITY, not as "at least these". A divergence that quietly heals is as much a signal
    // as a new one: it means a scanner changed without this file being revisited.
    const actual = CASES.filter((c) => JSON.stringify(canonical(c)) !== JSON.stringify(fourth(c)))
      .map((c) => c.label)
      .sort();
    expect(actual).toEqual([...DIVERGENT.keys()].sort());
  });

  it("names the shape of each divergence, so the direction is not lost", () => {
    const byLabel = new Map(CASES.map((c) => [c.label, c]));

    // Over-report: the canonical sees nothing, the fourth sees a specifier.
    const inlineType = byLabel.get("an all-inline-type clause is erased too")!;
    expect(canonical(inlineType)).toEqual([]);
    expect(fourth(inlineType)).toEqual(["./ab"]);

    // Under-report: the canonical sees the bare import, the fourth sees nothing.
    const bare = byLabel.get("a bare side-effect import")!;
    expect(canonical(bare)).toEqual(["./a.css"]);
    expect(fourth(bare)).toEqual([]);
  });
});
