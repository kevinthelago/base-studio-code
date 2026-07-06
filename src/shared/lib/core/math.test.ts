import { describe, it, expect } from "vitest";
import { clamp } from "./math";

// Covers the edge behaviors of BOTH former implementations (#2421): useDragResize's
// `clampSize(value, min, max)` and useGraphViewport's `clamp(v, a, b)` were the same
// `Math.max(min, Math.min(max, v))` chain — these pin that exact semantic.
describe("clamp", () => {
  it("returns the value when inside the range", () => {
    expect(clamp(200, 100, 300)).toBe(200);
  });
  it("clamps below min up to min", () => {
    expect(clamp(50, 100, 300)).toBe(100);
  });
  it("clamps above max down to max", () => {
    expect(clamp(999, 100, 300)).toBe(300);
  });
  it("is inclusive at both bounds", () => {
    expect(clamp(100, 100, 300)).toBe(100);
    expect(clamp(300, 100, 300)).toBe(300);
  });
  it("handles fractional values and negative ranges", () => {
    expect(clamp(0.5, 0, 1)).toBe(0.5);
    expect(clamp(-10, -5, 5)).toBe(-5);
    expect(clamp(0.005, 0.01, 8)).toBe(0.01);
  });
  it("returns min for an inverted range (min > max) — the Math.max-outermost chain semantic", () => {
    expect(clamp(5, 10, 0)).toBe(10);
  });
});
