// The Security page's graph records ↔ their source files (#4174, epic #3604).
//
// The Security workspace renders FROM THE GRAPH (#3646): the `securitypage` record and its four tab
// bodies are what mount, and `src/features/security/*.tsx` is a second copy nobody reads at runtime. So
// the file can be corrected and the record left behind, and nothing says a word — which is exactly what
// happened. #1039 removed `bsc-blocked --on`; `FlowTab.tsx` was updated to describe `bsc-wait` / `bsc-ask`
// instead; the `security-flow` record was not, and the Flow tab shipped an empty state telling the user to
// run a command that does not exist. It rendered that way for the whole of that time.
//
// While BOTH copies exist they must agree, and this is the check that says so. It compares what the two
// sources RENDER — every line except two kinds that cannot:
//   • MODULE SPECIFIERS, which the generator deliberately rewrites (siblings → `@/components/<id>`,
//     feature libs → absolute) or drops (the CSS import, the barrel re-exports) — see
//     `scripts/gen-security-graph.cjs`.
//   • COMMENTS. Not because stale prose is fine, but because parity is unachievable there and a gate that
//     fails for an unachievable reason teaches people to regenerate blindly. The generator strips the
//     barrel re-export STATEMENTS and leaves their leading comments orphaned in the record, so every edit
//     to a comment above the barrel would fail this test for a change that cannot reach a screen.
//     `securitypage` carries exactly that today: its record still describes the #1545 barrel as it read
//     before #3754 added the tunnel projection to it. Inert, and deliberately not chased.
// Everything else — the component bodies, the JSX, the strings the user reads — must be identical.
//
// This is a guard for a TRANSITIONAL state, not a permanent law: #4169 step 4 deletes the file once the
// graph copy is provably safe to be the only one, and this test goes with the file it guards. Until then
// the drift it catches is user-visible.
import { describe, it, expect } from "vitest";
import pageRecord from "@data/components/app/features/security/securitypage.json";
import profilesRecord from "@data/components/app/features/security/security-profiles.json";
import assignmentsRecord from "@data/components/app/features/security/security-assignments.json";
import activityRecord from "@data/components/app/features/security/security-activity.json";
import flowRecord from "@data/components/app/features/security/security-flow.json";
import pageSource from "./index.tsx?raw";
import profilesSource from "./ProfilesTab.tsx?raw";
import assignmentsSource from "./AssignmentsTab.tsx?raw";
import activitySource from "./ActivityTab.tsx?raw";
import flowSource from "./FlowTab.tsx?raw";

/** The generated provenance header the generator prepends — four lines, always first. */
const HEADER_LINES = 4;

/** A line that names a MODULE — an import, a re-export, or the tail of a multi-line import. These are the
 *  lines the generator rewrites or drops on purpose, and the only ones allowed to differ. */
const SPECIFIER_LINE =
  /^\s*(?:(?:import|export)\b[^;]*|\})\s*from\s*["'][^"']+["'];?\s*$|^\s*import\s+["'][^"']+["'];?\s*$/;

/** A comment-only line — a `//` line, or the opening or continuation of a block comment. */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

/** What a source RENDERS: its code lines. Specifiers and comments are excluded for the reasons above;
 *  BLANK lines go with them, because dropping a statement leaves the blank line that separated it and the
 *  record's blank-line count is therefore an artifact of the generator, not of the page. Line endings are
 *  normalised too — the records were generated from a CRLF checkout and a checkout today is LF. None of
 *  the three changes a pixel. */
function renderedLines(src: string): string[] {
  return src
    .replace(/\r/g, "")
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
  { id: "securitypage", record: pageRecord, source: pageSource },
  { id: "security-profiles", record: profilesRecord, source: profilesSource },
  { id: "security-assignments", record: assignmentsRecord, source: assignmentsSource },
  { id: "security-activity", record: activityRecord, source: activitySource },
  { id: "security-flow", record: flowRecord, source: flowSource },
];

describe("the Security page's graph records match their source files", () => {
  it.each(PAIRS)("$id renders exactly what its file renders", ({ record, source }) => {
    const fromRecord = renderedLines(withoutHeader(record.srcText));
    const fromFile = renderedLines(source);
    // Non-vacuity: if the filter ever ate the whole file, an empty-vs-empty comparison would pass while
    // checking nothing — the failure mode this whole file exists to rule out.
    expect(fromFile.length, "the file has content past its imports").toBeGreaterThan(20);
    expect(fromFile.length).toBeLessThan(source.split("\n").length); // …and specifier lines WERE dropped
    expect(fromRecord).toEqual(fromFile);
  });

  it("the Flow tab's empty state names commands that still exist (#4174)", () => {
    // The specific regression. `bsc-blocked` was removed with the whole runtime dependency-wait mechanism
    // (#1039) — no producer, no coordinator auto-wake — so advertising it sends the reader after a
    // `command not found`. Asserted on the RECORD, because the record is what renders.
    expect(flowRecord.srcText).not.toContain("bsc-blocked");
    expect(flowRecord.srcText).toContain("bsc-wait");
    expect(flowRecord.srcText).toContain("bsc-ask");
  });
});
