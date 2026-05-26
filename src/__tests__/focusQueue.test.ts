import { describe, it, expect } from "vitest";
import { enqueue, removeFromQueue, nextInCycle } from "../lib/focusQueue";

describe("enqueue", () => {
  it("appends a new pane in FIFO order", () => {
    expect(enqueue([1, 2], 3)).toEqual([1, 2, 3]);
  });

  it("de-duplicates an already-queued pane (same reference)", () => {
    const q = [1, 2];
    expect(enqueue(q, 2)).toBe(q);
  });

  it("skips the excluded pane (the one you're on)", () => {
    expect(enqueue([1], 4, 4)).toEqual([1]);
  });

  it("ignores negative indices", () => {
    const q = [1];
    expect(enqueue(q, -1)).toBe(q);
  });
});

describe("removeFromQueue", () => {
  it("removes a queued pane", () => {
    expect(removeFromQueue([1, 2, 3], 2)).toEqual([1, 3]);
  });

  it("is a no-op (same reference) for an absent pane", () => {
    const q = [1, 2];
    expect(removeFromQueue(q, 9)).toBe(q);
  });
});

describe("nextInCycle", () => {
  it("moves to the next waiting pane after the current one", () => {
    expect(nextInCycle([5, 6, 7], 5)).toBe(6);
  });

  it("wraps around to the front", () => {
    expect(nextInCycle([5, 6, 7], 7)).toBe(5);
  });

  it("starts at the front when the current pane isn't queued", () => {
    expect(nextInCycle([5, 6, 7], 9)).toBe(5);
  });

  it("returns null when the only queued pane is the current one", () => {
    expect(nextInCycle([5], 5)).toBeNull();
  });

  it("returns null for an empty queue", () => {
    expect(nextInCycle([], 3)).toBeNull();
  });
});
