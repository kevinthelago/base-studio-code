// What the Security → Flow tab TELLS the user (#4174).
//
// The record ↔ file parity guard lives in `src/app/runtime/graphParity.test.ts` and covers every page in
// one place. This is the part it cannot do: parity only proves the two copies AGREE, so a change that
// reverted both would sail through it. These assertions pin the CONTENT that was wrong, on the record,
// because the record is what renders.
import { describe, it, expect } from "vitest";
import flowRecord from "@data/components/app/features/security/security-flow.json";

/** Every packaged app graph record — the same glob `seed.ts` seeds the component library from, and the
 *  set that MOUNTS. `srcText` is the whole transcribed module, so this reads the rendered copy AND the
 *  comments around it. */
const APP_RECORDS = import.meta.glob<{ id: string; srcText?: string }>("@data/components/app/**/*.json", {
  eager: true,
  import: "default",
});

/** Collapse the JSX line-wrapping so an assertion pins the SENTENCE rather than where the formatter
 *  happened to break it. The records were generated from a CRLF checkout. */
const flat = (s: string) => s.replace(/\s+/g, " ");

describe("the Flow tab's empty state (#4174)", () => {
  it("names commands that still exist", () => {
    // `bsc-blocked` was removed with the whole runtime dependency-wait mechanism (#1039) — no producer, no
    // coordinator auto-wake — so advertising it sends the reader after a `command not found`. It shipped
    // that way for months because the file was corrected and the record, which mounts, was not.
    expect(flowRecord.srcText).not.toContain("bsc-blocked");
    expect(flowRecord.srcText).toContain("bsc-wait");
    expect(flowRecord.srcText).toContain("bsc-ask");
  });

  it("says the true thing, verbatim", () => {
    // The whole sentence, not just the two command names: the failure mode here was PROSE describing a
    // mechanism the app does not have, and a record could name `bsc-wait` while still claiming the fleet
    // parks sessions on a dependency. `bsc-wait` is the worker pausing for the USER and `bsc-ask` is it
    // asking the DIRECTOR — those are the only two ways a session lands in this list.
    expect(flat(flowRecord.srcText)).toContain(
      "The fleet is flowing. Sessions appear here when a worker pauses for you (<code>bsc-wait</code>) " +
      "or asks the director a question (<code>bsc-ask</code>).",
    );
  });

  it("no packaged app record anywhere advertises `bsc-blocked`", () => {
    // The Flow tab is the one that got caught, but the same stale instruction could be transcribed into
    // any other page's record, and a record is prose nobody lints. Historical mentions still live in the
    // source tree (`streamGate.ts` and `relationshipGraph.ts` both explain what #1039 removed and why) —
    // those are provenance in a module comment, not an instruction on a screen. A graph record IS the
    // screen, so here the string is simply not allowed.
    const records = Object.entries(APP_RECORDS);
    // Non-vacuity: a glob that stopped resolving would make this pass while checking nothing.
    expect(records.length, "the packaged app catalogue resolves").toBeGreaterThan(50);
    const offenders = records
      .filter(([, r]) => (r?.srcText ?? "").includes("bsc-blocked"))
      .map(([path, r]) => `${r?.id ?? path}`);
    expect(offenders).toEqual([]);
  });
});
