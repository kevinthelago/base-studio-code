// The instrumented-execution tracer (#3216) — TracedArray records the algorithm's real operations as
// frames, and runAlgorithm exposes them as a replay-safe generator.
import { describe, it, expect } from "vitest";
import { TracedArray, runAlgorithm } from "./tracer";
import type { ArrayFrame } from "./trace";

describe("TracedArray (#3216)", () => {
  it("emits an initial rest frame, then a frame per observable op", () => {
    const a = new TracedArray([3, 1, 2]);
    a.compare(0, 1);
    a.swap(0, 1);
    a.set(2, 9);
    a.mark(2, "pivot");
    const f = a.trace();
    expect(f.length).toBe(5); // initial + compare + swap + set + mark
    expect(f[0].ops).toBeUndefined(); // the input at rest
    expect(f[1].ops).toEqual([{ op: "compare", at: [0, 1] }]);
    expect(f[2].ops).toEqual([{ op: "swap", at: [0, 1] }]);
    expect(f[2].data).toEqual([1, 3, 2]); // the swap is applied to the snapshot
    expect(f[3].ops).toEqual([{ op: "set", at: 2 }]);
    expect(f[3].data).toEqual([1, 3, 9]);
    expect(f[4].ops).toEqual([{ op: "mark", at: 2, as: "pivot" }]);
  });

  it("compare returns the sign; get is a silent read (no frame)", () => {
    const a = new TracedArray([5, 2]);
    expect(a.compare(0, 1)).toBe(1); // 5 > 2
    expect(a.get(0)).toBe(5); // silent
    expect(a.trace().length).toBe(2); // initial + the one compare only
  });

  it("a moved cursor rides the next op frame", () => {
    const a = new TracedArray([1, 2, 3]);
    a.cursor("i", 2);
    a.compare(0, 1);
    expect(a.trace()[1].cursors).toEqual({ i: 2 });
  });

  it("markSorted marks every cell sorted", () => {
    const a = new TracedArray([1, 2]);
    a.markSorted();
    const t = a.trace();
    const last = t[t.length - 1];
    expect(last.ops).toEqual([
      { op: "mark", at: 0, as: "sorted" },
      { op: "mark", at: 1, as: "sorted" },
    ]);
  });
});

describe("runAlgorithm (#3216)", () => {
  it("returns a replay-safe factory and never mutates the input", () => {
    const input = [3, 1, 2];
    const factory = runAlgorithm((a) => a.swap(0, 2), input);
    const first = [...factory()].map((f) => (f as ArrayFrame).data);
    const second = [...factory()].map((f) => (f as ArrayFrame).data);
    expect(second).toEqual(first); // deterministic replay
    expect(input).toEqual([3, 1, 2]); // input untouched
  });
});
