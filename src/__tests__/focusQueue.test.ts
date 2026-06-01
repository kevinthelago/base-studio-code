import { describe, it, expect } from "vitest";
import { enqueue, removeFromQueue, nextInCycle, reconcileQueue, type QueuedPane } from "../lib/focusQueue";

const p = (tab: number, pane: number): QueuedPane => ({ tab, pane });

describe("enqueue", () => {
  it("appends a new pane in FIFO order", () => {
    expect(enqueue([p(0, 1), p(0, 2)], p(0, 3))).toEqual([p(0, 1), p(0, 2), p(0, 3)]);
  });

  it("de-duplicates an already-queued pane (same reference)", () => {
    const q = [p(0, 1), p(0, 2)];
    expect(enqueue(q, p(0, 2))).toBe(q);
  });

  it("treats the same pane index on different tabs as distinct", () => {
    expect(enqueue([p(0, 2)], p(1, 2))).toEqual([p(0, 2), p(1, 2)]);
  });

  it("ignores negative pane indices", () => {
    const q = [p(0, 1)];
    expect(enqueue(q, p(0, -1))).toBe(q);
  });
});

describe("removeFromQueue", () => {
  it("removes a queued pane", () => {
    expect(removeFromQueue([p(0, 1), p(0, 2), p(0, 3)], p(0, 2))).toEqual([p(0, 1), p(0, 3)]);
  });

  it("is a no-op (same reference) for an absent pane", () => {
    const q = [p(0, 1), p(0, 2)];
    expect(removeFromQueue(q, p(0, 9))).toBe(q);
    expect(removeFromQueue(q, p(1, 1))).toBe(q); // same index, different tab
  });
});

describe("nextInCycle", () => {
  it("moves to the next waiting pane after the current one", () => {
    expect(nextInCycle([p(0, 5), p(0, 6), p(0, 7)], p(0, 5))).toEqual(p(0, 6));
  });

  it("wraps around to the front", () => {
    expect(nextInCycle([p(0, 5), p(0, 6), p(0, 7)], p(0, 7))).toEqual(p(0, 5));
  });

  it("returns a waiting pane on another tab", () => {
    expect(nextInCycle([p(0, 5), p(1, 2)], p(0, 5))).toEqual(p(1, 2));
  });

  it("starts at the front when the current pane isn't queued", () => {
    expect(nextInCycle([p(0, 5), p(0, 6), p(0, 7)], p(0, 9))).toEqual(p(0, 5));
  });

  it("returns null when the only queued pane is the current one", () => {
    expect(nextInCycle([p(0, 5)], p(0, 5))).toBeNull();
  });

  it("returns null for an empty queue", () => {
    expect(nextInCycle([], p(0, 3))).toBeNull();
  });
});

describe("reconcileQueue", () => {
  // After #187 every tab is mounted, so the caller can pass live waiting sets
  // for ALL tabs in one go. Callers from #77 wire this up so background-tab
  // panes get pruned the same way active-tab panes do.
  const w = (entries: Record<number, number[]>): Map<number, Set<number>> =>
    new Map(Object.entries(entries).map(([t, panes]) => [Number(t), new Set(panes)]));

  it("drops a tab's panes that are no longer waiting", () => {
    expect(reconcileQueue([p(0, 1), p(0, 2), p(0, 3)], w({ 0: [1, 3] })))
      .toEqual([p(0, 1), p(0, 3)]);
  });

  it("prunes across multiple tabs in one sweep", () => {
    // p(0,3) no longer idle on tab 0; p(1,5) no longer idle on tab 1 — both go.
    const q = [p(0, 1), p(1, 5), p(0, 3), p(1, 2)];
    expect(reconcileQueue(q, w({ 0: [1], 1: [2] }))).toEqual([p(0, 1), p(1, 2)]);
  });

  it("returns the same reference when nothing is pruned", () => {
    const q = [p(0, 1), p(0, 2)];
    expect(reconcileQueue(q, w({ 0: [1, 2] }))).toBe(q);
  });

  it("empties when nothing on a single-tab queue is waiting", () => {
    expect(reconcileQueue([p(0, 1), p(0, 2)], w({ 0: [] }))).toEqual([]);
  });

  it("leaves tabs absent from the map alone (no live data → no assumption)", () => {
    // Tab 1 not in the map → its entries survive even if the caller has no
    // status info for them. Defensive against transient empty-state moments.
    const q = [p(0, 1), p(1, 2)];
    expect(reconcileQueue(q, w({ 0: [1] }))).toEqual([p(0, 1), p(1, 2)]);
  });
});
