import { describe, it, expect } from "vitest";
import { nudgeSizes } from "./terminalNudge";

describe("terminalNudge — nudgeSizes (#1221)", () => {
  it("shrinks by exactly one column for the transient, restores the true fitted size", () => {
    const s = nudgeSizes(80, 24)!;
    expect(s.transient).toEqual({ cols: 79, rows: 24 }); // delta != 0 → guaranteed SIGWINCH
    expect(s.restore).toEqual({ cols: 80, rows: 24 });    // net unchanged after the nudge
    // rows are untouched (avoids the #1158 input clip box)
    expect(s.transient.rows).toBe(s.restore.rows);
  });

  it("returns null when there's nothing safe to shrink", () => {
    expect(nudgeSizes(1, 24)).toBeNull();
    expect(nudgeSizes(0, 24)).toBeNull();
    expect(nudgeSizes(NaN, 24)).toBeNull();
  });
});
