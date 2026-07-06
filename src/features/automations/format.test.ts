import { describe, it, expect } from "vitest";
import { armedSummary } from "./format";

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

// fmtClock moved to @/shared/lib/core/format (#2421) — covered in shared/lib/core/format.test.ts.
