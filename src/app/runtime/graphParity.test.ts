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
// This is a PERMANENT guard, not a transitional one. Deleting a page's `.tsx` once its record renders was
// once the plan; it is not being done — the two copies coexist, and this check is the whole reason that is
// safe. A pair leaves it only if that page stops being sourced from the graph.
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
  // `ui-charts` cannot satisfy a one-file comparison BY CONSTRUCTION: it is three CTX-free source files
  // concatenated behind one `provides` — `charts/Charts.tsx` + `primitives.tsx` + `telemetry.tsx` (#3690)
  // — and `src` can only name one of them. This is the shape of exclusion the ratchet below is happy with:
  // it will never be "fixed", so it will never start passing, and the reason does not decay.
  "ui-charts": "the record concatenates 3 source files behind one `provides` (#3690); `src` names one",
  // `settingspage` lived here until #4183 deleted the dormant graph Settings path outright. The hole
  // closed by the page LEAVING, which is the better way for an exclusion to end.
};

/** The file half for records OUTSIDE the catalogue. Deliberately a separate glob from `shadowPages`'
 *  `FILE_SOURCES`: that one is enumerated per page and pinned by a test that every globbed file is
 *  declared, so a wide pattern there would fail by design. This one is lazy (no `eager`), so the breadth
 *  costs nothing until a record actually names a path. */
const RECORD_SOURCES = import.meta.glob<string>("/src/**/*.tsx", { query: "?raw", import: "default" });

/** The file behind a pair, from either half. */
async function sourceFor(file: string): Promise<string | null> {
  const catalogued = await loadFileSource(file);
  if (catalogued !== null) return catalogued;
  const loader = RECORD_SOURCES[file];
  return loader ? await loader() : null;
}

/** Every catalogue module that HAS both copies — a page whose file was deleted (fleet, #3636) has no
 *  baseline to compare against and is not a gap in the guard. */
const CATALOGUE_PAIRS = SHADOW_PAGES.flatMap((page) =>
  page.modules
    .filter((m): m is { recordId: string; file: string } => m.file !== null)
    .map((m) => ({ page: page.pageId, ...m })),
);

/** …AND every other packaged record whose `src` resolves to a real file (#4235). The catalogue is
 *  page-shaped, so the 57 `shared/ui` records — the whole design system, authored as data — sat outside
 *  this guard entirely. NINE of them had drifted, every one with the file as the newer copy: #3775's
 *  keyboard-operability work (`clickable(onClick)`, role/tabIndex/Enter-Space) had reached `ui-card`,
 *  `ui-data-table-row`, `ui-checkbox` and `ui-toggle` as FILES while the records still rendered a bare
 *  `onClick`; `ui-graph-canvas` still rendered a `<Box>` where #4140 had switched the file to
 *  `<div ref={setWorld}>` "because setWorld needs a REAL DOM ref", so the record never bound it at all.
 *  A guard scoped to pages could not see any of it — which is the whole lesson of #4174/#4179 repeating
 *  one level down. Coverage is now every record with a file, not every record on a page. */
const catalogued = new Set(CATALOGUE_PAIRS.map((p) => p.recordId));
const RECORD_PAIRS = [...RECORDS.values()]
  .map((r) => r as { id: string; src?: string })
  .filter((r) => r.src && !catalogued.has(r.id))
  .map((r) => ({ page: "record", recordId: r.id, file: `/${r.src}` }))
  .filter((p) => p.file in RECORD_SOURCES)
  .sort((a, b) => a.recordId.localeCompare(b.recordId));

/** …and the ones whose `src` names NO file (#4239). These are NOT compared — there is nothing to
 *  compare against — but the filter above used to drop them SILENTLY, and a record outside the guard is
 *  indistinguishable from a record that agrees with its file.
 *
 *  That is the exact failure `KNOWN_STALE` is written to avoid one paragraph up: *an exclusion nobody is
 *  forced to remove is how a guard quietly stops guarding.* `KNOWN_STALE` is ratcheted — its members must
 *  keep failing — while this exclusion was undeclared, uncounted, and joined the moment anyone renamed a
 *  file, which is precisely when parity most needs checking. 30 of 160 records had accumulated in it.
 *
 *  So it is declared and pinned below instead. The `RECORD_PAIRS.length` non-vacuity check cannot serve:
 *  it catches a TOTAL glob failure, not attrition — 130, 80 and 51 all satisfy it. */
const UNRESOLVED = [...RECORDS.values()]
  .map((r) => r as { id: string; src?: string })
  .filter((r) => r.src && !catalogued.has(r.id) && !(`/${r.src}` in RECORD_SOURCES))
  .map((r) => r.id)
  .sort();

/** The records currently outside the guard because their `src` resolves to nothing, pinned EXACTLY.
 *
 *  Two populations, and the distinction is the point:
 *  - **Graph-only** — `fleet-*`, whose files were deleted in #3636. The record is the only copy, so there
 *    is no baseline and never will be. The catalogue half states this explicitly as `file: null`; the
 *    record half has no such marker, so their broken `src` is doing that job by accident.
 *  - **Stale** — the rest. `github-*` is one rename wave (`GitHubOpenPRs.tsx` → the consolidated
 *    `Pulse.tsx`, and friends) that #4223 measured from the store side; `bsc ui backing relink` re-points
 *    exactly this shape.
 *
 *  Exact equality, not a count: a NEW unresolved record fails here (it cannot slip out of the guard), and
 *  a REPAIRED one fails here too (forcing the entry out, so the list can only shrink deliberately). */
const UNRESOLVED_PINNED: string[] = [
  // GRAPH-ONLY (#3636): the FleetPage source files were deleted, so the record is the only copy and
  // there is no baseline to compare against — permanent, and the same state the catalogue half declares
  // as `file: null`. These four are why the exclusion needs to EXIST; `ui-icons` was why it needed to be
  // VISIBLE (its `src` said `Icons.tsx` against a file named `icons.tsx` — one character, invisible on a
  // case-insensitive filesystem, and Vite's glob keys are exact, so a record #4235 had just brought under
  // the guard slipped straight back out of it. Fixed in this change rather than pinned).
  "fleet-cost-energy",
  "fleet-health",
  "fleet-lessons",
  "fleetpage",
];

const ALL_PAIRS = [...CATALOGUE_PAIRS, ...RECORD_PAIRS];
const PAIRS = ALL_PAIRS.filter((p) => !(p.recordId in KNOWN_STALE));
const STALE_PAIRS = ALL_PAIRS.filter((p) => p.recordId in KNOWN_STALE);

describe("records outside the comparison are declared, not dropped (#4239)", () => {
  it("matches the pinned set exactly", () => {
    // Failing here is the DESIGNED outcome of two different events, and both want a human:
    //   • an id APPEARED  → a record's `src` stopped resolving; it just left the guard silently.
    //   • an id VANISHED  → it was repaired; drop it from the pin so the list can only shrink.
    expect(UNRESOLVED).toEqual(UNRESOLVED_PINNED);
  });

  it("is a real exclusion list, not an artefact of a broken glob", () => {
    // If `RECORD_SOURCES` ever stopped matching, EVERY record would land in UNRESOLVED and the pin above
    // would fail with a wall of ids rather than pointing at the one that moved. Say so directly.
    expect(UNRESOLVED.length).toBeLessThan(RECORD_PAIRS.length);
  });
});

describe("every graph record renders what its source file renders", () => {
  it("covers the whole catalogue, minus the pages whose files are gone", () => {
    // Non-vacuity for the SET: a catalogue that stopped resolving would make every case below vanish and
    // the suite would still be green — the same silent-pass this file exists to prevent, one level up.
    expect(PAIRS.length).toBeGreaterThan(30);
    // …and the record half is real too (#4235): the 57 shared/ui records plus the feature-internal
    // ones. A typo in the glob would silently drop every one of them and this file would stay green.
    expect(RECORD_PAIRS.length).toBeGreaterThan(50);
    const graphOnly = SHADOW_PAGES.flatMap((p) => p.modules).filter((m) => m.file === null);
    expect(graphOnly.every((m) => m.recordId.startsWith("fleet")), "only fleet is graph-only today").toBe(true);
  });

  it.each(PAIRS)("$recordId ($page)", async ({ recordId, file }) => {
    const record = RECORDS.get(recordId);
    const source = await sourceFor(file);
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
    const source = await sourceFor(file);
    expect(renderedLines(record?.srcText ?? ""), KNOWN_STALE[recordId])
      .not.toEqual(renderedLines(source ?? ""));
  });
});
