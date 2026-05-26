import { describe, it, expect } from "vitest";
import { shouldAutoFocusOnIdle, shouldAdvanceOnReply, nextFullscreen, STARTUP_GRACE_MS, AUTOFOCUS_COOLDOWN_MS } from "../lib/consoleFocus";

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

  it("does not steal focus while a pane is maximized", () => {
    // The full-screen view shouldn't be yanked; Ctrl+Shift+N steps through instead.
    expect(shouldAutoFocusOnIdle(true, "idle", "run", false, Infinity, true)).toBe(false);
  });

  it("exposes positive grace and cooldown windows", () => {
    expect(STARTUP_GRACE_MS).toBeGreaterThan(0);
    expect(AUTOFOCUS_COOLDOWN_MS).toBeGreaterThan(0);
  });
});

describe("shouldAdvanceOnReply", () => {
  it("advances when you reply to the focused agent (idle -> run)", () => {
    expect(shouldAdvanceOnReply("idle", "run", 2, 2)).toBe(true);
  });

  it("does not advance for a non-focused pane resuming on its own", () => {
    expect(shouldAdvanceOnReply("idle", "run", 3, 2)).toBe(false);
  });

  it("does not advance on other transitions", () => {
    expect(shouldAdvanceOnReply("run", "idle", 2, 2)).toBe(false);
    expect(shouldAdvanceOnReply("run", "run", 2, 2)).toBe(false);
  });

  it("does nothing when no pane is focused", () => {
    expect(shouldAdvanceOnReply("idle", "run", -1, -1)).toBe(false);
  });
});

describe("nextFullscreen", () => {
  it("maximizes the target when nothing is currently fullscreen", () => {
    expect(nextFullscreen(3, -1)).toBe(3);
  });

  it("maximizes the target when a different pane is fullscreen", () => {
    expect(nextFullscreen(3, 5)).toBe(3);
  });

  it("restores the grid when the target is already fullscreen", () => {
    expect(nextFullscreen(3, 3)).toBe(-1);
  });

  it("is a no-op (null) when no pane is selected", () => {
    expect(nextFullscreen(-1, -1)).toBeNull();
    expect(nextFullscreen(-1, 2)).toBeNull();
  });
});
