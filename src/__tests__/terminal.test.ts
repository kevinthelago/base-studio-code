import { describe, it, expect } from "vitest";
import {
  scrollbackForPaneCount,
  totalMountedPaneCount,
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

  it("scales scrollback down as the workspace grows", () => {
    const single = scrollbackForPaneCount(1);
    const quad   = scrollbackForPaneCount(4);
    const nine   = scrollbackForPaneCount(9);
    const grid16 = scrollbackForPaneCount(16);
    const heavy32 = scrollbackForPaneCount(32);
    const wide50  = scrollbackForPaneCount(50);
    expect(single).toBeGreaterThan(quad);
    expect(quad).toBeGreaterThan(nine);
    expect(nine).toBeGreaterThan(grid16);
    expect(grid16).toBeGreaterThan(heavy32);
    expect(heavy32).toBeGreaterThan(wide50);
  });

  it("preserves the single-tab 4×4 budget (no regression for the common case)", () => {
    expect(scrollbackForPaneCount(16)).toBe(1500);
  });

  it("trims further for cross-tab workspaces — 17+ panes drops below the 16-pane budget (#52 / #187)", () => {
    // Two heavy tabs (e.g. one triage + one fleet) shouldn't double the
    // workspace-wide scrollback budget vs. a single tab.
    expect(scrollbackForPaneCount(17)).toBeLessThan(scrollbackForPaneCount(16));
    // And large fleets across many tabs trim again.
    expect(scrollbackForPaneCount(33)).toBeLessThan(scrollbackForPaneCount(32));
  });
});

describe("totalMountedPaneCount", () => {
  it("sums every tab's grid size", () => {
    const tabs = [{ layout: "2×2" }, { layout: "4×4" }, { layout: "1×1" }];
    expect(totalMountedPaneCount(tabs)).toBe(4 + 16 + 1);
  });

  it("returns 0 for no tabs", () => {
    expect(totalMountedPaneCount([])).toBe(0);
  });

  it("falls back to 1×1 for an unparseable layout (robust against corrupt persisted state)", () => {
    expect(totalMountedPaneCount([{ layout: "garbage" }])).toBe(1);
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
