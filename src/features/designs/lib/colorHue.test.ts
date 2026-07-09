import { describe, it, expect } from "vitest";
import { hueOfColor } from "./colorHue";

// Minimal circular distance between two hue angles (deg).
const circDist = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

describe("hueOfColor (#2663)", () => {
  it("reads the oklch() hue component directly, normalized into [0,360)", () => {
    expect(hueOfColor("oklch(0.72 0.15 190)")).toBeCloseTo(190, 5);
    expect(hueOfColor("oklch(72% 0.15 200.5)")).toBeCloseTo(200.5, 5);
    expect(hueOfColor("oklch(0.5 0.1 400)")).toBeCloseTo(40, 5); // wraps past 360
  });

  it("derives the OKLCH hue of the contract's hand-authored graph-category hexes", () => {
    // Independently-computed OKLCH hues of the six built-in category colours (±5° formula tolerance).
    const near = (v: string, deg: number) => expect(circDist(hueOfColor(v)!, deg)).toBeLessThan(5);
    near("#16b3a7", 186); // greenfield teal
    near("#7b74f2", 282); // transform indigo
    near("#b8862f", 77);  // harden amber
    near("#8b93a7", 268); // maintain slate
    near("#d05fa8", 343); // data pink
    near("#d0a92e", 90);  // script gold
  });

  it("accepts #rgb shorthand and is case-insensitive", () => {
    expect(hueOfColor("#0AF")).toBeCloseTo(hueOfColor("#00aaff")!, 5);
    expect(typeof hueOfColor("#0af")).toBe("number");
  });

  it("returns null for unsupported / non-colour input", () => {
    expect(hueOfColor("var(--x)")).toBeNull();
    expect(hueOfColor("rgb(1,2,3)")).toBeNull();
    expect(hueOfColor("#12")).toBeNull();
    expect(hueOfColor("nonsense")).toBeNull();
  });
});
