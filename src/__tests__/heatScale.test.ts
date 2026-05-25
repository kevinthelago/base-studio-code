import { describe, it, expect } from "vitest";
import { quartileScale } from "../screens/github/heatScale";

describe("quartileScale", () => {
  it("returns all zeros when there is no activity", () => {
    expect(quartileScale([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it("keeps empty days at 0 so they render as background", () => {
    const out = quartileScale([0, 5, 0, 10]);
    expect(out[0]).toBe(0);
    expect(out[2]).toBe(0);
  });

  it("emits only the four discrete quartile levels for non-zero days", () => {
    const out = quartileScale([1, 2, 3, 4, 5, 6, 7, 8]);
    const nonZero = out.filter(v => v > 0);
    nonZero.forEach(v => expect([0.25, 0.5, 0.75, 1]).toContain(v));
  });

  it("does not let a single huge outlier crush the normal days (the bug we are fixing)", () => {
    // Many 5–10 commit days + one 400. Under the old count/max scaling every
    // normal day collapsed to ~0.01–0.025; quartile bucketing must spread them
    // across the full range instead.
    const counts = [5, 6, 7, 8, 9, 10, 400];
    const out = quartileScale(counts);

    // The ordinary days now span multiple quartiles rather than all sitting at
    // the bottom — at minimum the busiest ordinary day reaches the top bucket.
    const ordinary = out.slice(0, 6);
    expect(new Set(ordinary).size).toBeGreaterThan(1);
    expect(Math.min(...ordinary)).toBe(0.25); // quietest day: level 1
    expect(Math.max(...ordinary)).toBe(1);    // busiest ordinary day: level 4

    // The outlier sits in the top bucket too — magnitude beyond the top
    // quartile is intentionally not distinguished by colour.
    expect(out[6]).toBe(1);
  });

  it("is monotonic: a higher count never yields a lower level", () => {
    const counts = [3, 1, 9, 5, 50, 12, 7];
    const out = quartileScale(counts);
    const pairs = counts.map((c, i) => [c, out[i]] as const).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < pairs.length; i++) {
      expect(pairs[i][1]).toBeGreaterThanOrEqual(pairs[i - 1][1]);
    }
  });

  it("places uniform non-zero activity in a single bucket", () => {
    expect(quartileScale([7, 7, 7, 7])).toEqual([0.25, 0.25, 0.25, 0.25]);
  });

  it("preserves input length and order", () => {
    const counts = [0, 12, 3, 0, 88, 4];
    expect(quartileScale(counts)).toHaveLength(counts.length);
  });
});
