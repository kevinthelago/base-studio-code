// The executable spec for the `windowed-tally.ts` graph node (#3465) — imports and RUNS the module
// whose text the graph ships as that node's `code`.
import { describe, it, expect } from "vitest";
import { dayWindow, tallyByDay, windowedTally } from "./windowedTally";

const NOW = new Date("2026-03-10T12:00:00Z");

describe("dayWindow", () => {
  it("is the last N UTC days ending at `now`, oldest first", () => {
    const win = dayWindow(3, NOW);
    expect(win.keys).toEqual(["2026-03-08", "2026-03-09", "2026-03-10"]);
    expect(win.labels).toEqual(["3/8", "3/9", "3/10"]);
  });

  it("crosses a month boundary without special-casing", () => {
    expect(dayWindow(3, new Date("2026-03-01T00:30:00Z")).keys)
      .toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]);
  });

  it("is empty for a non-positive window rather than throwing", () => {
    expect(dayWindow(0, NOW)).toEqual({ labels: [], keys: [] });
    expect(dayWindow(-5, NOW)).toEqual({ labels: [], keys: [] });
  });
});

describe("tallyByDay", () => {
  const win = dayWindow(3, NOW);

  it("counts per day and KEEPS EMPTY DAYS as zero", () => {
    // The reason the window is built first: a quiet day must be a 0 in the axis, not a missing entry.
    // Deriving labels from the data instead compresses it out and turns a gap into a dip.
    expect(tallyByDay(win, ["2026-03-08T01:00:00Z", "2026-03-10T09:00:00Z", "2026-03-10T23:00:00Z"]))
      .toEqual([1, 0, 2]);
  });

  it("skips null/undefined/unparseable entries instead of counting them", () => {
    // These streams come from APIs where "not merged yet" IS a null timestamp; filtering at the call
    // site would be required of every caller and forgotten by one of them.
    expect(tallyByDay(win, [null, undefined, "", "not-a-date", "2026-03-09T00:00:00Z"]))
      .toEqual([0, 1, 0]);
  });

  it("drops timestamps outside the window rather than clamping them to an edge", () => {
    // A clamped out-of-window event is a fabricated event on a real day — worse than a missing one.
    expect(tallyByDay(win, ["2020-01-01T00:00:00Z", "2030-01-01T00:00:00Z"])).toEqual([0, 0, 0]);
  });

  it("returns one entry per window day, always", () => {
    expect(tallyByDay(win, [])).toHaveLength(win.keys.length);
  });
});

describe("windowedTally", () => {
  it("aligns every series to ONE label axis", () => {
    const out = windowedTally(
      {
        landed: ["2026-03-08T01:00:00Z", "2026-03-10T01:00:00Z"],
        merged: ["2026-03-10T02:00:00Z", "2026-03-10T03:00:00Z", null],
      },
      3,
      NOW,
    );
    expect(out.labels).toEqual(["3/8", "3/9", "3/10"]);
    expect(out.series.landed).toEqual([1, 0, 1]);
    expect(out.series.merged).toEqual([0, 0, 2]);
    // The alignment guarantee, asserted rather than assumed: index i is the same day in every series.
    for (const s of Object.values(out.series)) expect(s).toHaveLength(out.labels.length);
  });

  it("keeps a stream with no events as an all-zero series, not an absent key", () => {
    const out = windowedTally({ landed: [], merged: ["2026-03-09T00:00:00Z"] }, 2, NOW);
    expect(out.series.landed).toEqual([0, 0]);
    expect(out.series.merged).toEqual([1, 0]);
  });

  it("shares ONE window across streams — the reason to prefer it over per-stream tallies", () => {
    // Two separately-built windows can straddle a day boundary and bucket the same instant differently.
    // Sharing the window makes that impossible rather than unlikely.
    const at = "2026-03-10T00:00:00Z";
    const out = windowedTally({ a: [at], b: [at] }, 4, NOW);
    expect(out.series.a).toEqual(out.series.b);
  });
});
