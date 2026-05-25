import { describe, it, expect } from "vitest";
import { shouldAutoFocusOnIdle, STARTUP_GRACE_MS } from "../lib/consoleFocus";

describe("shouldAutoFocusOnIdle", () => {
  it("steals focus when an agent finishes after the startup grace", () => {
    // The core workflow: an agent goes idle (needs direction) → focus jumps to it.
    expect(shouldAutoFocusOnIdle(true, "idle", "run", false)).toBe(true);
  });

  it("does NOT steal focus during the startup grace", () => {
    // 15 panes cold-starting would otherwise yank the cursor around the grid.
    expect(shouldAutoFocusOnIdle(true, "idle", "run", true)).toBe(false);
  });

  it("does nothing when auto-focus is disabled", () => {
    expect(shouldAutoFocusOnIdle(false, "idle", "run", false)).toBe(false);
  });

  it("only fires on a run -> idle transition", () => {
    expect(shouldAutoFocusOnIdle(true, "idle", "idle", false)).toBe(false);
    expect(shouldAutoFocusOnIdle(true, "run", "run", false)).toBe(false);
  });

  it("exposes a positive grace window", () => {
    expect(STARTUP_GRACE_MS).toBeGreaterThan(0);
  });
});
