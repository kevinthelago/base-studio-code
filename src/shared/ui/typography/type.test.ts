import { describe, it, expect } from "vitest";
import { fontSize, toneColor } from "./type";

describe("fontSize()", () => {
  it("maps named rungs to their pixel values", () => {
    expect(fontSize("xxs")).toBe(9);
    expect(fontSize("xs")).toBe(10);
    expect(fontSize("sm")).toBe(11);
    expect(fontSize("md")).toBe(12);
    expect(fontSize("lg")).toBe(14);
    expect(fontSize("xl")).toBe(18);
  });
  it("passes raw pixel numbers through unchanged (incl. off-scale half-sizes)", () => {
    expect(fontSize(10.5)).toBe(10.5);
    expect(fontSize(13)).toBe(13);
    expect(fontSize(0)).toBe(0);
  });
  it("returns undefined for undefined", () => {
    expect(fontSize(undefined)).toBeUndefined();
  });
});

describe("toneColor()", () => {
  it("maps each semantic tone to its color token", () => {
    expect(toneColor("dim")).toBe("var(--fg-dim)");
    expect(toneColor("muted")).toBe("var(--fg-muted)");
    expect(toneColor("accent")).toBe("var(--accent)");
    expect(toneColor("danger")).toBe("var(--danger)");
    expect(toneColor("success")).toBe("var(--success)");
  });
  it("returns undefined for undefined (inherit, no color forced)", () => {
    expect(toneColor(undefined)).toBeUndefined();
  });
});
