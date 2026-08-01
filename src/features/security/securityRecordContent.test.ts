// What the Security → Flow tab TELLS the user (#4174).
//
// The record ↔ file parity guard lives in `src/app/runtime/graphParity.test.ts` and covers every page in
// one place. This is the part it cannot do: parity only proves the two copies AGREE, so a change that
// reverted both would sail through it. These assertions pin the CONTENT that was wrong, on the record,
// because the record is what renders.
import { describe, it, expect } from "vitest";
import flowRecord from "@data/components/app/features/security/security-flow.json";

describe("the Flow tab's empty state (#4174)", () => {
  it("names commands that still exist", () => {
    // `bsc-blocked` was removed with the whole runtime dependency-wait mechanism (#1039) — no producer, no
    // coordinator auto-wake — so advertising it sends the reader after a `command not found`. It shipped
    // that way for months because the file was corrected and the record, which mounts, was not.
    expect(flowRecord.srcText).not.toContain("bsc-blocked");
    expect(flowRecord.srcText).toContain("bsc-wait");
    expect(flowRecord.srcText).toContain("bsc-ask");
  });
});
