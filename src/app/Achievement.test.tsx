import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { useAppStore } from "@/store";
import { Achievements } from "./Achievement";

// The generic, registry-driven achievement toast. The super-user achievement (trigger
// `liveAgents > 10`) stands in for "any achievement" here.
// #3939: the toast is a real card now, not an <img> of a pre-rendered banner — so it is found by its
// TITLE TEXT rather than alt text. That is the point of the change: the wording comes from the
// registry, so a new achievement is one JSON file rather than a hand-rendered bitmap.
const TITLE = /Claude Super User/i;

describe("Achievements", () => {
  beforeEach(() => {
    // No tree is mounted during beforeEach, so don't wrap the store reset in act(): calling React's
    // act() outside a test body corrupts the act environment for the next test (React 19 + RTL 16),
    // which left the following render empty and the toast never firing.
    useAppStore.setState({ achievements: {}, liveAgents: 0 });
  });

  it("stays hidden until an achievement's trigger fires", () => {
    render(<Achievements />);
    expect(screen.queryByText(TITLE)).toBeNull();
  });

  it("swipes in and records the unlock when a trigger crosses", async () => {
    render(<Achievements />);
    // Bare setState (no act): the subscribed component re-renders asynchronously under React 19, so
    // await the toast via findBy rather than wrapping the store write in act() (which is flaky here).
    useAppStore.setState({ liveAgents: 11 });
    // The toast image appears …
    expect(await screen.findByText(TITLE)).toBeTruthy();
    // … and the unlock is persisted (once-ever) in the store.
    expect(typeof useAppStore.getState().achievements["super-user"]).toBe("number");
  });

  it("does not re-fire once unlocked", () => {
    // Already unlocked from a prior session. Set state directly (no act) before mounting.
    useAppStore.setState({ achievements: { "super-user": 123 } });
    render(<Achievements />);
    useAppStore.setState({ liveAgents: 11 });
    // unlockAchievement is idempotent → returns false → no toast.
    expect(screen.queryByText(TITLE)).toBeNull();
  });
});
