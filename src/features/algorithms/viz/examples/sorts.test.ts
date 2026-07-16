// The sort family as REAL trace-programs (#3216) — each sorts correctly (so the animation is faithful),
// and the programs produce genuinely DIFFERENT op profiles (not the one shared animation).
import { describe, it, expect } from "vitest";
import { TracedArray } from "../../lib/tracer";
import { bubbleSort, insertionSort, quickSort, heapSort, mergeSort, TRACE_PROGRAMS, programKey, programForImpl } from "./sorts";
import type { ArrayFrame } from "../../lib/trace";

const PROGRAMS: Record<string, (a: TracedArray) => void> = { bubbleSort, insertionSort, quickSort, heapSort, mergeSort };
const asc = (a: number[]) => [...a].sort((x, y) => x - y);
const last = <T>(a: readonly T[]): T => a[a.length - 1];

function frames(algo: (a: TracedArray) => void, input: number[]): ArrayFrame[] {
  const a = new TracedArray(input);
  algo(a);
  return a.trace();
}
const opSig = (algo: (a: TracedArray) => void, input: number[]) =>
  frames(algo, input).flatMap((f) => f.ops ?? []).map((o) => o.op).join(",");

describe("sort trace-programs (#3216)", () => {
  const inputs = [[5, 2, 9, 1, 6, 3, 8, 4, 7], [3, 1, 2], [], [1], [2, 2, 1, 1], [5, 4, 3, 2, 1]];
  for (const name of Object.keys(PROGRAMS)) {
    it(`${name} ends sorted for every input — the animation is faithful to the real algorithm`, () => {
      for (const input of inputs) {
        expect(last(frames(PROGRAMS[name], input)).data).toEqual(asc(input));
      }
    });
  }

  it("different algorithms produce different op profiles — not the same animation", () => {
    const input = [5, 2, 9, 1, 6];
    const bubble = opSig(bubbleSort, input);
    const merge = opSig(mergeSort, input);
    const quick = opSig(quickSort, input);
    expect(merge).not.toBe(bubble);
    expect(quick).not.toBe(bubble);
    // Bubble swaps and never writes; merge writes (`set`) and never swaps — genuinely distinct traces.
    expect(bubble).toContain("swap");
    expect(bubble).not.toContain("set");
    expect(merge).toContain("set");
    expect(merge).not.toContain("swap");
  });
});

describe("programKey / programForImpl (#3216)", () => {
  it("normalizes an impl id to its base-algorithm key", () => {
    expect(programKey({ id: "merge-sort.rs" })).toBe("merge-sort");
    expect(programKey({ id: "quick_sort.ts" })).toBe("quick-sort");
    expect(programKey({ id: "sort.ts" })).toBe("sort");
  });

  it("resolves a program for the named sort family, undefined otherwise", () => {
    expect(programForImpl({ id: "merge-sort.rs", name: "merge_sort" })).toBe(TRACE_PROGRAMS["merge-sort"]);
    expect(programForImpl({ id: "heap-sort.rs", name: "heap_sort" })).toBe(TRACE_PROGRAMS["heap-sort"]);
    // topological-sort is a GRAPH algorithm — no array program (correctly no array animation until the
    // graph tracer lands), and an unknown algorithm has none either.
    expect(programForImpl({ id: "topological-sort.rs", name: "topological_sort" })).toBeUndefined();
    expect(programForImpl({ id: "nope.rs", name: "nope" })).toBeUndefined();
  });
});
