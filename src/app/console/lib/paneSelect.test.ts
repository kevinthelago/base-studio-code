import { describe, it, expect } from "vitest";
import { resolvePaneFromBuffer, PANE_SELECT_COMMIT_MS } from "./paneSelect";

describe("resolvePaneFromBuffer", () => {
  it("maps a single digit to a 0-based index", () => {
    expect(resolvePaneFromBuffer("1", 9)).toBe(0);
    expect(resolvePaneFromBuffer("9", 9)).toBe(8);
  });

  it("maps multi-digit numbers so panes 10+ are reachable", () => {
    expect(resolvePaneFromBuffer("10", 16)).toBe(9);
    expect(resolvePaneFromBuffer("13", 16)).toBe(12);
    expect(resolvePaneFromBuffer("16", 16)).toBe(15);
  });

  it("rejects a leading zero so pane 0 is never selected", () => {
    expect(resolvePaneFromBuffer("0", 16)).toBeNull();
    expect(resolvePaneFromBuffer("01", 16)).toBeNull();
  });

  it("rejects numbers beyond the active grid", () => {
    expect(resolvePaneFromBuffer("17", 16)).toBeNull();
    expect(resolvePaneFromBuffer("99", 16)).toBeNull();
  });

  it("rejects empty or non-numeric buffers", () => {
    expect(resolvePaneFromBuffer("", 16)).toBeNull();
    expect(resolvePaneFromBuffer("1a", 16)).toBeNull();
  });

  it("exposes a positive commit window", () => {
    expect(PANE_SELECT_COMMIT_MS).toBeGreaterThan(0);
  });
});
