// The Skills page's graph records ↔ their source files (#4179, epic #3604).
//
// The Skills workspace renders FROM THE GRAPH (#3654): the `skillspage` record and its six composed views
// are what mount, and `src/features/skills/*.tsx` is a second copy nobody reads at runtime. Two changes
// landed on 2026-07-26 four hours apart, on different copies, and neither was carried across — #3826's
// pill-switch rail facets went into the record only, #3854's search-led list header into the files only.
// So the page that rendered and the page the tests asserted were different pages for months, and the
// suite stayed green the whole time: #3854 even added "the header leads with search and shows neither
// digest nor connection state", which passes against a component nobody mounts.
//
// This is the check that says they must agree. It compares what the two sources RENDER — every line except
// two kinds that cannot:
//   • MODULE SPECIFIERS, which the generator deliberately rewrites (siblings → `@/components/<id>`,
//     feature libs → absolute) or drops (the CSS import, the barrel re-exports) — see
//     `scripts/gen-skills-graph.cjs`.
//   • COMMENTS and BLANK LINES. Not because stale prose is fine, but because parity there is
//     unachievable: stripping the barrel re-export STATEMENTS orphans their comments and leaves the blank
//     lines that separated them, so those counts are artifacts of the generator, not of the page. A gate
//     that fails for an unachievable reason only teaches people to regenerate blindly.
// Everything else — the component bodies, the JSX, the strings the user reads — must be identical.
//
// A guard for a TRANSITIONAL state, not a permanent law: #4169 step 4 deletes the file once the graph copy
// is provably safe to be the only one, and this test goes with the file it guards. (It duplicates the
// Security guard added in #4174 — when both have landed, the pair should collapse into one check driven by
// #4169's page catalogue, which already knows every record ↔ file pairing in the app.)
import { describe, it, expect } from "vitest";
import pageRecord from "@data/components/app/features/skills/skillspage.json";
import viewsRecord from "@data/components/app/features/skills/skills-views.json";
import newGroupRecord from "@data/components/app/features/skills/skills-new-group-dialog.json";
import drawerRecord from "@data/components/app/features/skills/skills-drawer.json";
import digestRecord from "@data/components/app/features/skills/skills-digest.json";
import lessonsRecord from "@data/components/app/features/skills/skills-lessons-tab.json";
import runsRecord from "@data/components/app/features/skills/skills-runs-tab.json";
import pageSource from "./index.tsx?raw";
import viewsSource from "./SkillsViews.tsx?raw";
import newGroupSource from "./NewGroupDialog.tsx?raw";
import drawerSource from "./SkillDrawer.tsx?raw";
import digestSource from "./SkillsDigest.tsx?raw";
import lessonsSource from "./LessonsTab.tsx?raw";
import runsSource from "./RunsTab.tsx?raw";

/** The generated provenance header the generator prepends — four lines, always first. */
const HEADER_LINES = 4;

/** A line that names a MODULE — an import, a re-export, or the tail of a multi-line import. These are the
 *  lines the generator rewrites or drops on purpose, and the only ones allowed to differ.
 *
 *  The trailing `//` comment is load-bearing: `export { SkillsGraphHost } from "./SkillsGraphHost"; // …`
 *  is a specifier line too, and a pattern anchored right after the `;` silently reports it as page
 *  content that the record is missing. (The generator's own strip regex has the same blind spot — see the
 *  note in this PR; it survives today only because a lazy match swallows the line as part of the
 *  re-export block around it.) */
const SPECIFIER_LINE =
  /^\s*(?:(?:import|export)\b[^;]*|\})\s*from\s*["'][^"']+["'];?\s*(?:\/\/.*)?$|^\s*import\s+["'][^"']+["'];?\s*(?:\/\/.*)?$/;

/** The BRACED import/export form, which routinely spans lines — `import {\n  a, b,\n} from "…";`. Only the
 *  closing `} from …` line matches [`SPECIFIER_LINE`], so the opening and the names in between would read
 *  as page content one copy has and the other does not. `[^}]*` cannot cross the closing brace, so this
 *  can never run away past its own statement and eat real code. */
const BRACED_MODULE_STATEMENT =
  /^[ \t]*(?:import|export)\s+(?:type\s+)?\{[^}]*\}\s*from\s*["'][^"']+["'];?[ \t]*(?:\/\/[^\n]*)?$/gm;

/** A JSX comment — a brace-wrapped block comment, possibly spanning lines. Renders nothing, and it is one
 *  more place the two copies have drifted: `skills-new-group-dialog`'s record carries a longer
 *  eslint-disable directive than its file. That directive only means anything on the FILE — nothing lints
 *  a record's `srcText` — so syncing it would be cargo-culting a lint suppression into a place that
 *  cannot lint. */
const JSX_COMMENT = /\{\s*\/\*[\s\S]*?\*\/\s*\}/g;

/** A comment-only line — a `//` line, or the opening or continuation of a block comment. */
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

/** A record's source with its generated header removed, so the two copies start at the same line. */
function withoutHeader(srcText: string): string {
  const lines = srcText.replace(/\r/g, "").split("\n");
  expect(lines[0], "the record starts with the generated provenance header").toContain("AS GRAPH SOURCE");
  return lines.slice(HEADER_LINES).join("\n");
}

const PAIRS = [
  { id: "skillspage", record: pageRecord, source: pageSource },
  { id: "skills-views", record: viewsRecord, source: viewsSource },
  { id: "skills-new-group-dialog", record: newGroupRecord, source: newGroupSource },
  { id: "skills-drawer", record: drawerRecord, source: drawerSource },
  { id: "skills-digest", record: digestRecord, source: digestSource },
  { id: "skills-lessons-tab", record: lessonsRecord, source: lessonsSource },
  { id: "skills-runs-tab", record: runsRecord, source: runsSource },
];

describe("the Skills page's graph records match their source files", () => {
  it.each(PAIRS)("$id renders exactly what its file renders", ({ record, source }) => {
    const fromRecord = renderedLines(withoutHeader(record.srcText));
    const fromFile = renderedLines(source);
    // Non-vacuity: if the filter ever ate the whole file, an empty-vs-empty comparison would pass while
    // checking nothing — the failure mode this whole file exists to rule out.
    // 10, not a rounder number: `NewGroupDialog` is a 17-code-line dialog and a higher floor would fail
    // it for being small rather than for being wrong.
    expect(fromFile.length, "the file has content past its imports").toBeGreaterThan(10);
    expect(fromFile.length).toBeLessThan(source.split("\n").length); // …and specifier lines WERE dropped
    expect(fromRecord).toEqual(fromFile);
  });

  it("the rendered page carries BOTH changes that landed on 2026-07-26 (#4179)", () => {
    // The specific regression, asserted on the RECORD, because the record is what renders.
    // #3826/#3833 — the rail facets are pill switches, with the pressed state on the row's button.
    expect(pageRecord.srcText).toContain("<Toggle on={on} size=\"xs\" />");
    expect(pageRecord.srcText).toContain("aria-pressed={on}");
    // #3854 — the list header LEADS with search, and the always-on KPI strip is gone in favour of a
    // stats-free toggle that still opens the digest panel.
    expect(pageRecord.srcText).toContain("aria-label=\"Search skills\"");
    expect(pageRecord.srcText).toContain("SkillsDigestToggle");
    expect(pageRecord.srcText, "the KPI strip #3854 removed").not.toContain("SkillsDigestBar");
    expect(pageRecord.srcText, "search no longer sits in the rail's tools slot").not.toContain("tools={");
    expect(digestRecord.srcText, "the digest module exports the toggle, not the bar").toContain("SkillsDigestToggle");
    expect(digestRecord.srcText).not.toContain("SkillsDigestBar");
  });

  it("no `//` comment sits in JSX children position, where it would RENDER (#4179)", () => {
    // `<Box>` then `// note` is not a comment, it is text — it rendered above the rail. Only invisible
    // because the file is not what mounts, and a straight file → record sync would have shipped it.
    for (const { id, source } of PAIRS) {
      const lines = source.replace(/\r/g, "").split("\n");
      lines.forEach((line, i) => {
        const previous = lines.slice(0, i).reverse().find((l) => l.trim() !== "");
        const opensJsx = /^\s*<[A-Za-z][^/]*>\s*$/.test(previous ?? "");
        expect(opensJsx && /^\s*\/\//.test(line), `${id}:${i + 1} — a // comment inside JSX children renders as text`)
          .toBe(false);
      });
    }
  });
});
