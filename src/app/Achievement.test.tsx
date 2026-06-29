import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { useAppStore } from "@/store";
import { Achievements } from "./Achievement";

// The generic, registry-driven achievement toast. The super-user achievement (trigger
// `liveAgents > 10`) stands in for "any achievement" here.
const ALT = /Claude Super User achievement unlocked/i;

describe("Achievements", () => {
  beforeEach(() => {
    act(() => useAppStore.setState({ achievements: {}, liveAgents: 0 }));
  });

  it("stays hidden until an achievement's trigger fires", () => {
    render(<Achievements />);
    expect(screen.queryByAltText(ALT)).toBeNull();
  });

  it("swipes in and records the unlock when a trigger crosses", () => {
    render(<Achievements />);
    act(() => useAppStore.setState({ liveAgents: 11 }));
    // The toast image appears …
    expect(screen.getByAltText(ALT)).toBeTruthy();
    // … and the unlock is persisted (once-ever) in the store.
    expect(typeof useAppStore.getState().achievements["super-user"]).toBe("number");
  });

  it("does not re-fire once unlocked", () => {
    // Already unlocked from a prior session.
    act(() => useAppStore.setState({ achievements: { "super-user": 123 } }));
    render(<Achievements />);
    act(() => useAppStore.setState({ liveAgents: 11 }));
    // unlockAchievement is idempotent → returns false → no toast.
    expect(screen.queryByAltText(ALT)).toBeNull();
  });
});
