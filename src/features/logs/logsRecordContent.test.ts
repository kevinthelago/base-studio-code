// No packaged app record may advertise `bsc-blocked` (#4174).
//
// This started as three assertions on the Security → Flow record, whose empty state told the user to run
// a command #1039 had removed. TWO of them are gone with the record: the Flow tab is deleted
// (retire-agentprofile-and-strip-security-to-activity), because a view of a mechanism the app no longer
// has can only ever render its idle state.
//
// The THIRD assertion is the one that generalized, so it is the one that survives — and it is now the
// whole file. A record IS the screen, and a record is prose nobody lints, so the stale instruction could
// be transcribed onto any other page just as easily as it was onto this one. Keeping the sweep after the
// record that motivated it is the difference between fixing a bug and closing the class.
import { describe, it, expect } from "vitest";

/** Every packaged app graph record — the same glob `seed.ts` seeds the component library from, and the
 *  set that MOUNTS. `srcText` is the whole transcribed module, so this reads the rendered copy AND the
 *  comments around it. */
const APP_RECORDS = import.meta.glob<{ id: string; srcText?: string }>("@data/components/app/**/*.json", {
  eager: true,
  import: "default",
});

describe("the removed dependency-wait command (#4174)", () => {
  it("no packaged app record anywhere advertises `bsc-blocked`", () => {
    // `bsc-blocked` was removed with the whole runtime dependency-wait mechanism (#1039) — no producer, no
    // coordinator auto-wake — so advertising it sends the reader after a `command not found`. It shipped
    // that way for months because the FILE was corrected and the record, which mounts, was not.
    //
    // Historical mentions still live in the source tree (`streamGate.ts` and `relationshipGraph.ts` both
    // explain what #1039 removed and why) — those are provenance in a module comment, not an instruction
    // on a screen. A graph record IS the screen, so here the string is simply not allowed.
    const records = Object.entries(APP_RECORDS);
    // Non-vacuity: a glob that stopped resolving would make this pass while checking nothing.
    expect(records.length, "the packaged app catalogue resolves").toBeGreaterThan(50);
    const offenders = records
      .filter(([, r]) => (r?.srcText ?? "").includes("bsc-blocked"))
      .map(([path, r]) => `${r?.id ?? path}`);
    expect(offenders).toEqual([]);
  });

  it("the Flow record it was written against is really gone", () => {
    // Otherwise this file quietly narrows: a resurrected Flow tab would be swept by the check above only
    // if it happened to name the command, and the POINT is that the view has no mechanism behind it.
    const ids = Object.values(APP_RECORDS).map((r) => r?.id);
    expect(ids).not.toContain("security-flow");
    expect(ids).not.toContain("security-profiles");
    expect(ids).not.toContain("security-assignments");
  });
});
