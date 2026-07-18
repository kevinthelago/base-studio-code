import { describe, it, expect } from "vitest";
import { coordEventCue, cuesForLines } from "./notifyCues";
import type { CoordEvent } from "@/shared/lib/fleet/coordination";

describe("coordEventCue", () => {
  it("maps landings and merges to the success cue", () => {
    const landed: CoordEvent = { type: "landed", ref: { kind: "issue", number: 42 }, at: 1 };
    const merged: CoordEvent = { type: "merged", ref: { kind: "issue", number: 7 }, at: 2 };
    expect(coordEventCue(landed)).toBe("success");
    expect(coordEventCue(merged)).toBe("success");
  });

  it("maps a failure to the error cue", () => {
    const failed: CoordEvent = { type: "failed", ref: { kind: "issue", number: 9 }, reason: "boom", at: 3 };
    expect(coordEventCue(failed)).toBe("error");
  });

  it("maps a user-wait (bsc-wait) to the notify cue", () => {
    const waiting: CoordEvent = { type: "waiting", session: "p:s1", reason: "needs review", at: 4 };
    expect(coordEventCue(waiting)).toBe("notify");
  });

  it("is silent for events that aren't user-facing completions/pauses", () => {
    const closed: CoordEvent = { type: "closed", ref: { kind: "issue", number: 1 }, at: 5 };
    const woke: CoordEvent = { type: "woke", session: "p:s1", at: 6 };
    const ask: CoordEvent = { type: "ask", session: "p:s1", question: "?", at: 7 };
    expect(coordEventCue(closed)).toBeNull();
    expect(coordEventCue(woke)).toBeNull();
    expect(coordEventCue(ask)).toBeNull();
  });
});

describe("cuesForLines", () => {
  // Raw $BSC_COORD_LOG lines are TSV: `ts \t session \t kind \t <payload…>`.
  const line = (session: string, kind: string, ...payload: string[]) =>
    ["2026-07-17T00:00:00.000Z", session, kind, ...payload].join("\t");

  it("selects cues for the voiced events in a batch, in order", () => {
    const lines = [
      line("director", "merged", "#42"),
      line("p:s1", "waiting", "needs review"),
      line("p:s2", "failed", "#9", "tests red"),
    ];
    expect(cuesForLines(lines)).toEqual(["success", "notify", "error"]);
  });

  it("drops unparseable and non-voiced lines", () => {
    const lines = [
      "garbage-with-no-tabs",
      line("p:s1", "ask", "how?"),        // parseable but not voiced
      line("director", "landed", "#3"),   // voiced
    ];
    expect(cuesForLines(lines)).toEqual(["success"]);
  });

  it("returns an empty array for an empty batch", () => {
    expect(cuesForLines([])).toEqual([]);
  });

  it("preserves duplicates (the hook de-dupes per tick, the mapping stays faithful)", () => {
    const lines = [line("d", "merged", "#1"), line("d", "merged", "#2")];
    expect(cuesForLines(lines)).toEqual(["success", "success"]);
  });
});
