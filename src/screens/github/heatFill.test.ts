import { describe, it, expect } from "vitest";
import { heatFill } from "./heatFill";

/** Pull the L / C / H numbers out of an `oklch(L C H)` string. */
const parse = (s: string) => {
  const m = s.match(/oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/);
  return m ? { l: +m[1], c: +m[2], h: +m[3] } : null;
};

const TIERS = [0.25, 0.5, 0.75, 1];

describe("heatFill", () => {
  it("renders empty days as the elevated background, distinct from any activity", () => {
    expect(heatFill(0)).toBe("var(--bg-elev)");
  });

  it("treats negative values as empty", () => {
    expect(heatFill(-0.3)).toBe("var(--bg-elev)");
  });

  it("locks every non-zero tier to the accent's orange hue (70°) — never cool", () => {
    // Regression: color-mixing accent into the cool background dragged low
    // tiers toward blue (hue ~205). Every tier must stay at hue 70.
    for (const v of TIERS) {
      const p = parse(heatFill(v));
      expect(p).not.toBeNull();
      expect(p!.h).toBe(70);
    }
  });

  it("reproduces --accent (oklch 0.80 0.14 70) at full activity", () => {
    const p = parse(heatFill(1))!;
    expect(p.l).toBeCloseTo(0.8, 2);
    expect(p.c).toBeCloseTo(0.14, 2);
    expect(p.h).toBe(70);
  });

  it("is a monotonic intensity ramp: lightness and chroma both rise with activity", () => {
    const levels = TIERS.map(v => parse(heatFill(v))!);
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i].l).toBeGreaterThan(levels[i - 1].l);
      expect(levels[i].c).toBeGreaterThan(levels[i - 1].c);
    }
  });

  it("keeps the lowest tier clearly lighter than the empty background (L ≈ 0.21)", () => {
    expect(parse(heatFill(0.25))!.l).toBeGreaterThan(0.21);
  });

  it("clamps values above 1 to the accent endpoint", () => {
    expect(heatFill(1.5)).toBe(heatFill(1));
  });
});
