// Every graph record renders what its source file renders (#4181, epic #3604).
//
// A migrated page has TWO copies: the graph record, which is what MOUNTS, and the `.tsx` it was
// transcribed from, which is what the tests render. While both exist an edit lands on one of them and
// nothing says a word — and the one that is not what mounts is the one people read. That has now cost two
// user-visible bugs:
//
//   #4174 — `security-flow`'s record still told the user to run `bsc-blocked --on`, removed with #1039.
//           The file was corrected at the time. The record renders.
//   #4179 — Skills drifted in BOTH directions on the same day: pill-switch rail facets went to the record
//           only (#3826), the search-led header to the files only (#3854). What rendered and what the
//           tests asserted were different pages, and the suite was green throughout — #3854's own test
//           "the header leads with search" passed against a component nobody mounts.
//
// Each of those fixes shipped its own copy of this check, for Security and for Skills. This is the two of
// them collapsed into one, driven by #4169's shadow catalogue — which already knows every record ↔ file
// pairing in the app and is itself pinned to reality (every `role: "page"` record must appear in it, every
// declared file must resolve). So the guard now covers the GitHub, Automations, MCP, Settings and Projects
// pages too, which had none.
//
// It is STRICTER than shadow mode's structural diff. That diff sees JSX elements, so it reports a page
// whose skeleton drifted; this compares code, so it also catches a hook body, a const, or a handler that
// only one copy grew.
//
// A guard for a TRANSITIONAL state, not a permanent law: #4169 step 4 deletes each file once its graph
// copy is provably safe to be the only one, and each pair leaves this check when its file does.
import { describe, it, expect } from "vitest";
import { SHADOW_PAGES, loadFileSource } from "./shadowPages";

/** The packaged graph records — the same glob `seed.ts` seeds the component library from. */
const seedRecords = import.meta.glob<{ id: string; srcText: string }>("@data/components/app/**/*.json", {
  eager: true,
  import: "default",
});
const RECORDS = new Map(Object.values(seedRecords).map((r) => [r.id, r]));

/** A line that names a MODULE — an import, a re-export, or the tail of a multi-line import. These the
 *  generators rewrite (siblings → `@/components/<id>`, feature libs → absolute) or drop (the CSS import,
 *  the barrel re-exports), so they are the only lines allowed to differ.
 *
 *  The trailing `//` comment is load-bearing: `export { SkillsGraphHost } from "./SkillsGraphHost"; // …`
 *  is a specifier line too, and a pattern anchored right after the `;` reports it as page content the
 *  record is missing. (#4179 found this the hard way.) */
const SPECIFIER_LINE =
  /^\s*(?:(?:import|export)\b[^;]*|\})\s*from\s*["'][^"']+["'];?\s*(?:\/\/.*)?$|^\s*import\s+["'][^"']+["'];?\s*(?:\/\/.*)?$/;

/** The BRACED import/export form, which routinely spans lines — `import {\n  a, b,\n} from "…";`. Only its
 *  closing line matches [`SPECIFIER_LINE`], so the opening and the names between would read as page content
 *  one copy has and the other does not. `[^}]*` cannot cross the closing brace, so this can never run away
 *  past its own statement and eat real code. */
const BRACED_MODULE_STATEMENT =
  /^[ \t]*(?:import|export)\s+(?:type\s+)?\{[^}]*\}\s*from\s*["'][^"']+["'];?[ \t]*(?:\/\/[^\n]*)?$/gm;

/** A JSX comment — a brace-wrapped block comment, possibly spanning lines. Renders nothing, and it is one
 *  place the copies have drifted: `skills-new-group-dialog`'s record carries a longer eslint-disable
 *  directive than its file. That directive only means anything on the FILE — nothing lints a record's
 *  `srcText` — so syncing it would be cargo-culting a lint suppression into a place that cannot lint. */
const JSX_COMMENT = /\{\s*\/\*[\s\S]*?\*\/\s*\}/g;

/** A comment-only line — a `//` line, or the opening or continuation of a block comment. Excluded not
 *  because stale prose is fine but because parity is unachievable there: the generators strip the barrel
 *  re-export STATEMENTS and leave their leading comments orphaned in the record, so every edit to a comment
 *  above a barrel would fail this for a change that cannot reach a screen. (`securitypage` carries exactly
 *  that: its record describes the #1545 barrel as it read before #3754.) It also means the generated
 *  provenance header needs no special handling — it is just more comment lines. */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

/** What a source RENDERS: its code lines, with line endings normalised (the records were generated from a
 *  CRLF checkout and a checkout today is LF — which changes nothing that mounts). */
function renderedLines(src: string): string[] {
  return src
    .replace(/\r/g, "")
    .replace(JSX_COMMENT, "")
    .replace(BRACED_MODULE_STATEMENT, "")
    .split("\n")
    .filter((line) => line.trim() !== "" && !SPECIFIER_LINE.test(line) && !COMMENT_LINE.test(line));
}

/** Records KNOWN to be stale, excluded from the check with the reason — and held to that by the ratchet
 *  below, which fails if one of them starts passing. An exclusion nobody is forced to remove is how a
 *  guard quietly stops guarding. */
const KNOWN_STALE: Record<string, string> = {
  settingspage:
    "the record has no Accessibility section (#3804 added it to the file). Settings renders from FILES " +
    "since the #3758 roll-back, so this is DORMANT — and syncing it is not a copy-paste: the record would " +
    "import `AccessibilityPage`, which is neither a graph sibling nor registered in the settings " +
    "graph-platform, so the page would fail to load. That work belongs with re-enabling the graph " +
    "Settings page, not here. See #4181.",
};

/** Every catalogue module that HAS both copies — a page whose file was deleted (fleet, #3636) has no
 *  baseline to compare against and is not a gap in the guard. */
const ALL_PAIRS = SHADOW_PAGES.flatMap((page) =>
  page.modules
    .filter((m): m is { recordId: string; file: string } => m.file !== null)
    .map((m) => ({ page: page.pageId, ...m })),
);
const PAIRS = ALL_PAIRS.filter((p) => !(p.recordId in KNOWN_STALE));
const STALE_PAIRS = ALL_PAIRS.filter((p) => p.recordId in KNOWN_STALE);

describe("every graph record renders what its source file renders", () => {
  it("covers the whole catalogue, minus the pages whose files are gone", () => {
    // Non-vacuity for the SET: a catalogue that stopped resolving would make every case below vanish and
    // the suite would still be green — the same silent-pass this file exists to prevent, one level up.
    expect(PAIRS.length).toBeGreaterThan(30);
    const graphOnly = SHADOW_PAGES.flatMap((p) => p.modules).filter((m) => m.file === null);
    expect(graphOnly.every((m) => m.recordId.startsWith("fleet")), "only fleet is graph-only today").toBe(true);
  });

  it.each(PAIRS)("$recordId ($page)", async ({ recordId, file }) => {
    const record = RECORDS.get(recordId);
    const source = await loadFileSource(file);
    // No provenance-header assertion: `projectspage` was authored by hand (#3874, the largest record at
    // ~25k chars) rather than by a `gen-*-graph.cjs` script, so it has none. The header is comment lines
    // either way, dropped below — the real non-vacuity guards are the line counts.
    expect(record?.srcText, `${recordId} is in the packaged records`).toBeTruthy();
    expect(source, `${file} resolves through the catalogue's raw glob`).toBeTruthy();

    const fromRecord = renderedLines(record?.srcText ?? "");
    const fromFile = renderedLines(source ?? "");
    // Non-vacuity for the CASE: if the filters ever ate a whole file, an empty-vs-empty comparison would
    // pass while checking nothing. The floor is low because the catalogue's smallest pair is genuinely
    // small — `settings-mcp`'s page file is 7 code lines — and a floor that fails a file for being short
    // rather than for being wrong would just get deleted.
    expect(fromFile.length, "the file has content past its imports").toBeGreaterThan(3);
    expect(fromFile.length).toBeLessThan((source ?? "").split("\n").length); // …and specifiers WERE dropped
    expect(fromRecord).toEqual(fromFile);
  });

  it("no `//` comment sits in JSX children position, where it would RENDER", async () => {
    // `<Box>` then `// note` is not a comment, it is TEXT. `skills/index.tsx` carried one for months
    // (#4179) — invisible only because the file is not what mounts, and exactly what a straight file →
    // record sync would have shipped to the screen. Checked on the FILES, which is where it can be
    // written by hand; a generator never introduces one.
    const offenders: string[] = [];
    for (const { recordId, file } of ALL_PAIRS) {
      const lines = ((await loadFileSource(file)) ?? "").replace(/\r/g, "").split("\n");
      lines.forEach((line, i) => {
        const previous = lines.slice(0, i).reverse().find((l) => l.trim() !== "");
        if (/^\s*<[A-Za-z][^/]*>\s*$/.test(previous ?? "") && /^\s*\/\//.test(line)) {
          offenders.push(`${recordId} (${file}:${i + 1})`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  // The ratchet. Each excluded record must STILL be stale — the moment one is fixed, this fails and the
  // entry has to come out of KNOWN_STALE, which puts it back under the real check above. Without this, an
  // exclusion outlives its reason and the hole it leaves is invisible.
  it.each(STALE_PAIRS)("$recordId is still stale — drop its KNOWN_STALE entry once it is fixed", async ({ recordId, file }) => {
    const record = RECORDS.get(recordId);
    const source = await loadFileSource(file);
    expect(renderedLines(record?.srcText ?? ""), KNOWN_STALE[recordId])
      .not.toEqual(renderedLines(source ?? ""));
  });
});
