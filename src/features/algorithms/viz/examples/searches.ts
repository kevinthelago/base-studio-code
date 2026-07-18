// Array SEARCH trace-programs (#3220, epic #3215) — the real search algorithms written over a TracedArray,
// so the animation is DERIVED from each search's own execution: linear search walks every cell left to
// right; binary search halves its window, probing only the midpoints. There are no hand-drawn frames — the
// tracer records exactly what the code does, and the two look completely different because they ARE.
//
// THE OP VOCABULARY (#3220): a search examines ONE cell against an EXTERNAL target, so it emits `probe`
// (single-cell) rather than the sorts' pairwise `compare` — see the `ArrayOp` doc in lib/trace.ts. The hit
// is the terminal `found` mark (`TracedArray.found`), the search-family twin of the sorts' `markSorted`.
//
// Keyed by base name (`binary-search`, `linear-search`) like the sorts, so the seeded Rust impls
// (`binary-search.rs` / `linear-search.rs`) animate via their JS trace-program.
import type { TracedArray } from "../../lib/tracer";
import { parseSortInput } from "./sort";

/** A search's input — the cells to search plus the target being looked for (the value that is NOT in the
 *  array's own vocabulary, which is exactly why a search probes rather than compares). */
export interface SearchInput {
  values: number[];
  target: number;
}

/** A visualizable search algorithm — its real logic over a {@link TracedArray} + the array/target to seed
 *  it. `run` returns the found index (`-1` when absent), so the program is a genuine search, not a
 *  frame-emitter. */
export interface SearchProgram {
  run: (a: TracedArray, target: number) => number;
  defaultInput: SearchInput;
}

/** The linear-search seed — deliberately UNSORTED (a linear scan needs no order) with the target late in
 *  the array, so the walk is visible before the hit. */
const LINEAR_MOCK: SearchInput = { values: [5, 2, 9, 1, 6, 3, 8, 4, 7], target: 3 };

/** The binary-search seed — SORTED (binary search's precondition), with a target that takes several
 *  halvings to reach, so the shrinking window reads clearly. */
const BINARY_MOCK: SearchInput = { values: [1, 3, 4, 7, 9, 12, 15, 18, 21], target: 15 };

/**
 * Linear search — walk left to right, probing each cell against the target, and stop at the FIRST hit.
 * Returns that index, or `-1` when the target is absent. Every cell it looks at emits a `probe`; the hit
 * ends on a terminal `found` mark.
 */
export function linearSearch(a: TracedArray, target: number): number {
  for (let i = 0; i < a.length; i++) {
    a.cursor("i", i);
    if (a.probe(i) === target) {
      a.found(i);
      return i;
    }
  }
  return -1;
}

/**
 * Binary search over a SORTED array — halve the live window `[lo, hi)` each step, probing its midpoint and
 * discarding the half that cannot contain the target. Returns the index of the hit, or `-1` when absent.
 * The `lo` / `mid` / `hi` cursors ride each frame, so the window visibly closes in.
 *
 * The array is searched AS GIVEN (the program never sorts it first) — instrumented execution shows what
 * the real algorithm does, including on input that breaks its sorted precondition.
 */
export function binarySearch(a: TracedArray, target: number): number {
  let lo = 0;
  let hi = a.length; // exclusive — the window is [lo, hi)
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    a.cursor("lo", lo);
    a.cursor("hi", hi - 1); // the pill points at the last cell still in the window
    a.cursor("mid", mid);
    const v = a.probe(mid);
    if (v === target) {
      a.found(mid);
      return mid;
    }
    if (v < target) lo = mid + 1;
    else hi = mid;
  }
  return -1;
}

/** The visualizable search algorithms, keyed by base name (#3220). */
export const SEARCH_PROGRAMS: Record<string, SearchProgram> = {
  "linear-search": { run: linearSearch, defaultInput: LINEAR_MOCK },
  "binary-search": { run: binarySearch, defaultInput: BINARY_MOCK },
};

/** Serialize a search input to the "your input" text form — the values, then the target after a `|`. */
export function searchToText(input: SearchInput): string {
  return `${input.values.join(", ")} | ${input.target}`;
}

/**
 * Parse the "your input" text into a {@link SearchInput} — the values (comma/whitespace separated, via
 * {@link parseSortInput}) then the target after a single `|`. Throws a helpful `Error` (shown under the
 * field) when the separator or the target is missing or non-numeric.
 */
export function parseSearchInput(text: string): SearchInput {
  const parts = text.split("|");
  if (parts.length !== 2) throw new Error("Put the target after a single '|', e.g. 1, 3, 5 | 3");
  const values = parseSortInput(parts[0]);
  const targetText = parts[1].trim();
  if (targetText.length === 0) throw new Error("Add the target after the '|', e.g. 1, 3, 5 | 3");
  const target = Number(targetText);
  if (!Number.isFinite(target)) throw new Error(`"${targetText}" is not a number`);
  return { values, target };
}
