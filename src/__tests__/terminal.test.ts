import { describe, it, expect } from "vitest";
import { scrollbackForPaneCount } from "../lib/terminal";

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
