import { describe, it, expect } from "vitest";
import { shouldAutoFocusOnIdle, STARTUP_GRACE_MS, AUTOFOCUS_COOLDOWN_MS } from "../lib/consoleFocus";

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

  it("suppresses a steal within the cooldown after a recent steal", () => {
    // Another pane settling right after a steal must not yank the cursor back.
    expect(shouldAutoFocusOnIdle(true, "idle", "run", false, AUTOFOCUS_COOLDOWN_MS - 1)).toBe(false);
  });

  it("allows a steal once the cooldown has elapsed", () => {
    expect(shouldAutoFocusOnIdle(true, "idle", "run", false, AUTOFOCUS_COOLDOWN_MS)).toBe(true);
  });

  it("does not gate the first idle in a quiet stretch (no prior steal)", () => {
    // Default msSinceLastAutoFocus is Infinity → cooldown never applies.
    expect(shouldAutoFocusOnIdle(true, "idle", "run", false)).toBe(true);
  });

  it("exposes positive grace and cooldown windows", () => {
    expect(STARTUP_GRACE_MS).toBeGreaterThan(0);
    expect(AUTOFOCUS_COOLDOWN_MS).toBeGreaterThan(0);
  });
});
