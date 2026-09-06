// The precondition for deleting a module: does the packaged SEED already answer its specifier?
//
// Importers keep writing `@/x/y`; once the file is gone the only thing that can answer them is a
// shipped record. Two real failures in one slice came from nobody checking:
//
//   * five modules were retired while `bsc ui promote-seed` had SKIPPED their seed write — deleted, with
//     the old preview-shaped derivative still shipping. The recovery is worse than the bug, because
//     `bsc ui promote-seed` iterates FILES: once the file is gone the stale seed can never be adopted.
//   * `pageheader` whose seed said `@/shared/ui/pages/PageHeader` against a `pageHeader.tsx` file.
//
// NEITHER WAS CAUGHT BY ANYTHING — tsc resolves case-insensitively on Windows, `vite build` passed and
// the whole suite passed. That is why the match here is EXACT and a near miss is reported separately.
import { describe, it, expect } from "vitest";
// A relative path on purpose: `scripts/` is outside the `@/` alias (which maps to `src/`).
import { seedAnswersSpecifier } from "./lib/recordSource.mjs";

describe("seedAnswersSpecifier", () => {
  it("passes when a seed record provides exactly that specifier", () => {
    const r = seedAnswersSpecifier({ spec: "@/shared/ui/data/LabelChip", seedProvides: ["@/x", "@/shared/ui/data/LabelChip"] });
    expect(r.ok).toBe(true);
    expect(r.nearMiss).toEqual([]);
  });

  it("REFUSES when nothing provides it — the skipped-seed case", () => {
    // `bsc ui promote-seed` declined the write, so the seed still holds the old derivative with no
    // `provides` at all. Retiring here deletes the module and leaves importers with nothing.
    const r = seedAnswersSpecifier({ spec: "@/shared/ui/layout/Slot", seedProvides: ["@/shared/ui/data/LabelChip"] });
    expect(r.ok).toBe(false);
    expect(r.nearMiss).toEqual([]);
  });

  it("REFUSES a CASE MISMATCH, and names it — the `pageheader` case", () => {
    // The loader compares specifiers by string and `.bsc-records/` emission is keyed off `provides`,
    // so this keeps working on Windows and breaks on a case-sensitive filesystem. A case-insensitive
    // check would wave through exactly the bug that does not reproduce locally.
    const r = seedAnswersSpecifier({
      spec: "@/shared/ui/pages/pageHeader",
      seedProvides: ["@/shared/ui/pages/PageHeader"],
    });
    expect(r.ok).toBe(false);
    expect(r.nearMiss).toEqual(["@/shared/ui/pages/PageHeader"]);
  });

  it("tolerates surrounding whitespace in a stored `provides`", () => {
    expect(seedAnswersSpecifier({ spec: "@/a/b", seedProvides: ["  @/a/b  "] }).ok).toBe(true);
  });

  it("is not fooled by a PREFIX — a longer specifier is a different module", () => {
    const r = seedAnswersSpecifier({ spec: "@/shared/ui/Button", seedProvides: ["@/shared/ui/ButtonGroup"] });
    expect(r.ok).toBe(false);
    expect(r.nearMiss).toEqual([]);
  });
});
