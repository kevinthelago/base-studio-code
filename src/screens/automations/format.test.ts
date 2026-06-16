import { describe, it, expect } from "vitest";
import { armedSummary, fmtClock } from "./format";

const a = (armed: boolean, nextRunAt: number | null) => ({ armed, nextRunAt });

describe("armedSummary (status-bar live data)", () => {
  it("counts only armed schedules and takes the soonest next run", () => {
    const r = armedSummary([
      a(true, 5_000),
      a(false, 1_000), // disarmed — ignored, even though it's sooner
      a(true, 3_000),
      a(true, 9_000),
    ]);
    expect(r).toEqual({ count: 3, nextAt: 3_000 });
  });

  it("is zero/null when nothing is armed", () => {
    expect(armedSummary([a(false, 1_000), a(false, 2_000)])).toEqual({ count: 0, nextAt: null });
    expect(armedSummary([])).toEqual({ count: 0, nextAt: null });
  });

  it("counts an armed schedule even when its next run is null", () => {
    expect(armedSummary([a(true, null)])).toEqual({ count: 1, nextAt: null });
    // armed-with-time still wins the nextAt when mixed with armed-without-time
    expect(armedSummary([a(true, null), a(true, 4_000)])).toEqual({ count: 2, nextAt: 4_000 });
  });
});

describe("fmtClock", () => {
  it("renders HH:MM, padded", () => {
    const d = new Date(2026, 0, 1, 2, 0).getTime(); // 02:00 local
    expect(fmtClock(d)).toBe("02:00");
  });
  it("renders an em dash for null", () => {
    expect(fmtClock(null)).toBe("—");
  });
});
