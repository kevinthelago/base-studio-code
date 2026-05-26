import { describe, it, expect } from "vitest";
import {
  scrollbackForPaneCount,
  clampFontSize,
  adjustFontSize,
  DEFAULT_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
} from "../lib/terminal";

describe("scrollbackForPaneCount", () => {
  it("keeps a deep buffer for a single pane", () => {
    expect(scrollbackForPaneCount(1)).toBe(10000);
  });

  it("scales scrollback down as the grid grows", () => {
    const single = scrollbackForPaneCount(1);
    const quad   = scrollbackForPaneCount(4);
    const nine   = scrollbackForPaneCount(9);
    const grid16 = scrollbackForPaneCount(16);
    expect(single).toBeGreaterThan(quad);
    expect(quad).toBeGreaterThan(nine);
    expect(nine).toBeGreaterThan(grid16);
  });

  it("gives the 4×4 triage grid the smallest buffer", () => {
    expect(scrollbackForPaneCount(16)).toBe(1500);
  });

  it("treats pane counts beyond 16 the same as the largest tier", () => {
    expect(scrollbackForPaneCount(25)).toBe(scrollbackForPaneCount(16));
  });
});

describe("clampFontSize", () => {
  it("leaves a size within range untouched", () => {
    expect(clampFontSize(14)).toBe(14);
  });

  it("clamps below the legible floor", () => {
    expect(clampFontSize(MIN_TERMINAL_FONT_SIZE - 5)).toBe(MIN_TERMINAL_FONT_SIZE);
  });

  it("clamps above the ceiling", () => {
    expect(clampFontSize(MAX_TERMINAL_FONT_SIZE + 10)).toBe(MAX_TERMINAL_FONT_SIZE);
  });

  it("rounds to whole pixels", () => {
    expect(clampFontSize(12.6)).toBe(13);
  });

  it("falls back to the default for non-finite input", () => {
    expect(clampFontSize(NaN)).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    expect(clampFontSize(Infinity)).toBe(DEFAULT_TERMINAL_FONT_SIZE);
  });
});

describe("adjustFontSize", () => {
  it("steps up and down by whole pixels", () => {
    expect(adjustFontSize(12, +1)).toBe(13);
    expect(adjustFontSize(12, -1)).toBe(11);
  });

  it("stays clamped when stepping past a bound", () => {
    expect(adjustFontSize(MAX_TERMINAL_FONT_SIZE, +1)).toBe(MAX_TERMINAL_FONT_SIZE);
    expect(adjustFontSize(MIN_TERMINAL_FONT_SIZE, -1)).toBe(MIN_TERMINAL_FONT_SIZE);
  });
});
