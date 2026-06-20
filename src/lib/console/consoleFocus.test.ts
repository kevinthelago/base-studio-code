import { describe, it, expect } from "vitest";
import { shouldAdvanceOnReply, nextFullscreen } from "./consoleFocus";

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
