import { describe, it, expect } from "vitest";
import { enqueue, removeFromQueue, dequeueNext } from "../lib/focusQueue";

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

describe("dequeueNext", () => {
  it("takes the front and returns the rest", () => {
    expect(dequeueNext([5, 6, 7])).toEqual({ next: 5, rest: [6, 7] });
  });

  it("returns null for an empty queue", () => {
    expect(dequeueNext([])).toEqual({ next: null, rest: [] });
  });
});
