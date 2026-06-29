import { describe, it, expect } from "vitest";
import { isBenign } from "./fatalOverlay";

// Regression: the crash overlay must NOT fire on benign browser warnings — notably the
// ResizeObserver loop message the planner's resizable split panes emit on resize, which was
// surfacing as a full-screen "Uncaught error" overlay (false crash).
describe("fatalOverlay.isBenign", () => {
  it("ignores the ResizeObserver loop warnings", () => {
    expect(isBenign("ResizeObserver loop completed with undelivered notifications")).toBe(true);
    expect(isBenign("ResizeObserver loop limit exceeded")).toBe(true);
  });

  it("ignores the opaque cross-origin Script error", () => {
    expect(isBenign("Script error.")).toBe(true);
  });

  it("does NOT ignore real errors", () => {
    expect(isBenign("TypeError: Cannot read properties of undefined (reading 'x')")).toBe(false);
    expect(isBenign("")).toBe(false);
  });
});
