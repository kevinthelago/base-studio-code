// Human presence (#4248) — the signal the navigate gate turns on.
import { describe, it, expect, beforeEach } from "vitest";
import {
  noteHumanActivity, humanPresent, msSinceHumanActivity,
  __resetHumanPresence, installHumanPresence, PRESENT_WINDOW_MS,
} from "./humanPresence";

beforeEach(() => __resetHumanPresence());

describe("humanPresent", () => {
  /** The unattended default. A machine that has seen no input since load is the overnight loop's world,
   *  and the gate must not fire there — that is the case the steering was built for. */
  it("is false when no input has ever been seen", () => {
    expect(humanPresent(1_000_000)).toBe(false);
    expect(msSinceHumanActivity(1_000_000)).toBeNull();
  });

  it("is true immediately after input, and until the window elapses", () => {
    noteHumanActivity(1000);
    expect(humanPresent(1000)).toBe(true);
    expect(humanPresent(1000 + PRESENT_WINDOW_MS - 1)).toBe(true);
  });

  it("goes false once the window elapses — a machine left alone becomes unattended", () => {
    noteHumanActivity(1000);
    expect(humanPresent(1000 + PRESENT_WINDOW_MS)).toBe(false);
  });

  /** Long enough to cover reading between actions: the designer loop fires ~every 7s, so a shorter
   *  window would let it take the screen between two keystrokes — the complaint itself. */
  it("spans more than one designer-loop iteration", () => {
    expect(PRESENT_WINDOW_MS).toBeGreaterThan(7_000 * 2);
  });

  it("never moves the timestamp backwards", () => {
    noteHumanActivity(5000);
    noteHumanActivity(1000); // a stale/out-of-order event
    expect(humanPresent(5000 + PRESENT_WINDOW_MS - 1)).toBe(true);
  });

  it("reports how long since, so a decline is checkable", () => {
    noteHumanActivity(1000);
    expect(msSinceHumanActivity(4000)).toBe(3000);
  });
});

describe("installHumanPresence", () => {
  it("records real input events and stops after disposal", () => {
    const target = new EventTarget();
    const dispose = installHumanPresence(target);

    expect(humanPresent()).toBe(false);
    target.dispatchEvent(new Event("keydown"));
    expect(humanPresent()).toBe(true);

    __resetHumanPresence();
    dispose();
    target.dispatchEvent(new Event("keydown"));
    expect(humanPresent(), "disposed listeners must stop recording").toBe(false);
  });

  /** NOT mousemove: it fires from incidental cursor drift and from automation, and would report a
   *  person in an empty room — permanently disabling the steer the loop depends on. */
  it("ignores mousemove", () => {
    const target = new EventTarget();
    installHumanPresence(target);
    target.dispatchEvent(new Event("mousemove"));
    expect(humanPresent()).toBe(false);
  });
});
