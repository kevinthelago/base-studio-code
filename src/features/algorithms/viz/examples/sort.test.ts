// The seeded sort proof (#3177) — `sortSteps` yields a monotonically-improving (by inversion count)
// sequence that ends fully sorted, and `sort` returns the sorted array (draining the same generator).
import { describe, it, expect } from "vitest";
import { sortSteps, sort, SORT_MOCK, parseSortInput } from "./sort";
import { programVizForImpl } from "./registry";
import type { ArrayFrame } from "../../lib/trace";

/** The number of inversions in `a` — pairs out of order. A perfect measure of "sortedness": strictly
 *  decreases toward 0 as an ascending sort makes progress, and is 0 exactly when `a` is sorted. */
function inversions(a: number[]): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) if (a[i] > a[j]) n++;
  return n;
}

const asc = (a: readonly number[]) => [...a].sort((x, y) => x - y);
/** Last element (this tsconfig's lib target predates Array.prototype.at). */
const last = <T,>(a: readonly T[]): T => a[a.length - 1];

describe("sortSteps (#3177)", () => {
  it("yields a non-worsening (by inversion count) sequence ending fully sorted", () => {
    const frames = [...sortSteps([...SORT_MOCK])];
    const invs = frames.map((f) => inversions(f.data as number[]));

    // Monotonically improving: inversion count never increases from one frame to the next.
    for (let i = 1; i < invs.length; i++) expect(invs[i]).toBeLessThanOrEqual(invs[i - 1]);

    // It starts unsorted (there is real work to show) and ends sorted (0 inversions).
    expect(invs[0]).toBeGreaterThan(0);
    expect(last(invs)).toBe(0);
    expect(last(frames).data).toEqual(asc(SORT_MOCK));
  });

  it("each swap frame removes exactly one inversion (the swap verb === one exchange)", () => {
    const frames = [...sortSteps([...SORT_MOCK])];
    for (let i = 1; i < frames.length; i++) {
      const prev = inversions(frames[i - 1].data as number[]);
      const cur = inversions(frames[i].data as number[]);
      const isSwap = frames[i].ops?.some((o) => o.op === "swap");
      if (isSwap) expect(cur).toBe(prev - 1);
      else expect(cur).toBe(prev);
    }
  });

  it("carries the contract verbs + cursors: compare/swap ops with i,j cursors, and a terminal sorted mark", () => {
    const frames = [...sortSteps([...SORT_MOCK])];
    // Every op-bearing mid-run frame is a compare or swap and carries both cursors.
    const mid = frames.slice(1, -1).filter((f) => f.ops && f.ops.length > 0);
    expect(mid.length).toBeGreaterThan(0);
    for (const f of mid) {
      expect(f.ops!.every((o) => o.op === "compare" || o.op === "swap")).toBe(true);
      expect(f.cursors).toMatchObject({ i: expect.any(Number), j: expect.any(Number) });
    }
    // The terminal frame marks every cell sorted.
    const terminal = last(frames);
    expect(terminal.ops).toHaveLength(SORT_MOCK.length);
    expect(terminal.ops!.every((o) => o.op === "mark" && (o as { as: string }).as === "sorted")).toBe(true);
  });

  it("is a pure function of its input across replays (identical frame sequence each call)", () => {
    const a = [4, 2, 5, 1, 3];
    const first = [...sortSteps([...a])].map((f) => f.data);
    const second = [...sortSteps([...a])].map((f) => f.data);
    expect(second).toEqual(first);
  });

  it("is idempotent on an already-sorted input (a compare-only pass, no swaps)", () => {
    const frames: ArrayFrame[] = [...sortSteps([1, 2, 3, 4])];
    expect(frames.some((f) => f.ops?.some((o) => o.op === "swap"))).toBe(false);
    expect(last(frames).data).toEqual([1, 2, 3, 4]);
  });
});

describe("sort (#3177)", () => {
  it("returns the ascending-sorted array by draining the generator", () => {
    expect(sort(SORT_MOCK)).toEqual(asc(SORT_MOCK));
    expect(sort([3, 1, 2])).toEqual([1, 2, 3]);
    expect(sort([])).toEqual([]);
    expect(sort([9])).toEqual([9]);
    expect(sort([2, 2, 1, 1])).toEqual([1, 1, 2, 2]);
  });

  it("does not mutate its input (pure)", () => {
    const input = [5, 3, 1, 4, 2];
    const copy = [...input];
    sort(input);
    expect(input).toEqual(copy);
  });
});

describe("parseSortInput (#3199 custom state)", () => {
  it("parses comma- and/or whitespace-separated numbers", () => {
    expect(parseSortInput("5, 2, 9, 1")).toEqual([5, 2, 9, 1]);
    expect(parseSortInput("3 1 2")).toEqual([3, 1, 2]);
    expect(parseSortInput(" 4 ,5,  6 ")).toEqual([4, 5, 6]);
    expect(parseSortInput("-2, 0, 3.5")).toEqual([-2, 0, 3.5]);
  });

  it("throws a helpful Error on empty input, a non-number, or an unwatchable length", () => {
    expect(() => parseSortInput("   ")).toThrow(/at least one number/i);
    expect(() => parseSortInput("5, abc, 2")).toThrow(/"abc" is not a number/);
    expect(() => parseSortInput(Array.from({ length: 41 }, () => "1").join(","))).toThrow(/under 40/i);
  });
});

describe("sort example input seam (#3199/#3216)", () => {
  it("resolves each named sort algorithm to its OWN program, and nothing for an unknown one", () => {
    // Program-driven (#3216): keyed by the algorithm's base name, not by kind — each sort has its own.
    expect(programVizForImpl({ id: "sort.ts", name: "sort" })).toBeDefined();
    expect(programVizForImpl({ id: "merge-sort.rs", name: "merge_sort" })).toBeDefined();
    expect(programVizForImpl({ id: "quick-sort.rs", name: "quick_sort" })).toBeDefined();
    expect(programVizForImpl({ id: "nope.rs", name: "nope" })).toBeUndefined(); // no program
  });

  it("make(parse(default)) reproduces the default factory trace", async () => {
    const viz = programVizForImpl({ id: "sort.ts", name: "sort" })!;
    const factory = await viz.input.make(viz.input.parse(viz.input.default)); // async now (#3233)
    const fromDefault = [...factory()].map((f) => (f as ArrayFrame).data);
    const fromFactory = [...viz.factory()].map((f) => (f as ArrayFrame).data);
    expect(fromDefault).toEqual(fromFactory);
  });
});
