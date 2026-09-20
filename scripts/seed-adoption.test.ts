// `seedAdoption` — the one case where a promotion is allowed to OVERWRITE an existing packaged seed.
//
// `bsc components promote-seed` never overwrites a seed, because seven curated ones were clobbered before that
// guard existed. This rule is its single inversion, so it is tested rather than trusted: the guard
// protects a curated seed from a worse record, and adoption only fires when the seed is the worse copy.
//
// Every case here is a real one from the 10-module drain, not an invented one.
import { describe, it, expect } from "vitest";
// A relative path on purpose: `scripts/` is outside the `@/` alias (which maps to `src/`).
import { seedAdoption } from "./lib/recordSource.mjs";

/** The file, as a record would hold it — what both copies are graded against. */
const FILE = `import { Box } from "@/shared/ui/layout/Box";\nexport function Titlebar() {\n  return <Box />;\n}\n`;
/** A record opens with an "AS GRAPH SOURCE" preamble the file never had; it must not count as a difference. */
const PREAMBLE = `// Titlebar, AS GRAPH SOURCE (#3604). Transcribed from the live feature file.\n`;

const verdict = (o: Parameters<typeof seedAdoption>[0]) => seedAdoption(o).verdict;

describe("seedAdoption", () => {
  it("ADOPTS when the seed's body is behind the file", () => {
    // `statusbar`, `titlebar` and `terminalbanners` were all in this state, and all three carried no
    // `provides` at all — so retiring the file would have left the specifier answered by nothing.
    expect(
      verdict({
        seedSrcText: `export function Titlebar() {\n  return null;\n}\n`,
        seedProvides: null,
        recordSrcText: PREAMBLE + FILE,
        recordProvides: "@/app/chrome/Titlebar",
        fileSrc: FILE,
      }),
    ).toBe("adopt");
  });

  it("ADOPTS when only the `provides` is wrong, body identical", () => {
    // `skills-lessons-tab`: its body already matched, and its `provides` was
    // `@/components/skills-lessons-tab` while every importer of the retired file names
    // `@/features/skills/LessonsTab`. A body-only check called this "keep" and would have shipped the
    // specifier answered by nothing — the exact hole the tranche existed to close.
    expect(
      verdict({
        seedSrcText: PREAMBLE + FILE,
        seedProvides: "@/components/titlebar",
        recordSrcText: PREAMBLE + FILE,
        recordProvides: "@/app/chrome/Titlebar",
        fileSrc: FILE,
      }),
    ).toBe("adopt");
  });

  it("KEEPS when the seed matches the file AND the provides agree", () => {
    expect(
      verdict({
        seedSrcText: PREAMBLE + FILE,
        seedProvides: "@/app/chrome/Titlebar",
        recordSrcText: FILE,
        recordProvides: "@/app/chrome/Titlebar",
        fileSrc: FILE,
      }),
    ).toBe("keep");
  });

  it("REFUSES when adopting would drop an export the seed declares", () => {
    // The one way this can ship a module short a symbol — and `provides` overrides are already known
    // for exactly that (`tunnelsettings` was found claiming a specifier while missing `relayHealthUrl`).
    const r = seedAdoption({
      seedSrcText: `export function Titlebar() {}\nexport function WindowControls() {}\n`,
      seedProvides: null,
      recordSrcText: PREAMBLE + FILE,
      recordProvides: "@/app/chrome/Titlebar",
      fileSrc: FILE,
    });
    expect(r.verdict).toBe("refuse");
    expect(r.lost).toEqual(["WindowControls"]);
  });

  it("REFUSAL outranks adoption — a stale seed that would lose an export is still refused", () => {
    // Both conditions true at once: the body differs AND an export would go. Losing the symbol is the
    // worse outcome, so it must not be adopted on the strength of being stale.
    expect(
      verdict({
        seedSrcText: `export function Titlebar() { return 1; }\nexport const KEEP = 1;\n`,
        seedProvides: null,
        recordSrcText: PREAMBLE + FILE,
        recordProvides: "@/app/chrome/Titlebar",
        fileSrc: FILE,
      }),
    ).toBe("refuse");
  });

  it("does not judge an opaque `export * from` — it is unknown, never 'exports nothing'", () => {
    // `exportedNames` returns null for a star re-export. Treating that as an empty set would report
    // every symbol as lost and refuse a perfectly good adoption.
    expect(
      verdict({
        seedSrcText: `export * from "@/app/chrome/parts";\n`,
        seedProvides: null,
        recordSrcText: PREAMBLE + FILE,
        recordProvides: "@/app/chrome/Titlebar",
        fileSrc: FILE,
      }),
    ).toBe("adopt");
  });

  it("does not mistake the record's PREAMBLE for a difference", () => {
    // Overwriting `srcText` with the raw file deleted these blocks before, and four records shrank
    // while their change only meant to add attributes.
    expect(
      verdict({
        seedSrcText: `// a DIFFERENT preamble\n` + FILE,
        seedProvides: "@/app/chrome/Titlebar",
        recordSrcText: PREAMBLE + FILE,
        recordProvides: "@/app/chrome/Titlebar",
        fileSrc: FILE,
      }),
    ).toBe("keep");
  });
});
