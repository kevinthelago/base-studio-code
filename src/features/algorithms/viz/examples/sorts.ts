// The sort family as REAL trace-programs (#3216, epic #3215) — each is the genuine algorithm written
// against a TracedArray, so its animation is DERIVED from its own execution and looks distinct: bubble's
// adjacent swaps, insertion's shifting prefix, quick's partitions, heap's sift-downs, merge's writes.
// There are no hand-drawn frames — the tracer records what the code does.
//
// Keyed by the algorithm's BASE NAME (`merge-sort`, not `merge-sort.rs`), so a Rust reference impl and any
// TypeScript twin share one visualization (the JS trace-program is the visualizable form; the Rust stays
// shown in the code panel). `programForImpl` normalizes an impl id to that key.
import { TracedArray } from "../../lib/tracer";
import { SORT_MOCK } from "./sort";

/** A visualizable algorithm — its real logic over a {@link TracedArray} + the default input to seed it. */
export interface AlgoProgram {
  /** The algorithm, written against the traced structure (its ops become the animation). */
  run: (a: TracedArray) => void;
  /** The default input the inline preview + "your input" field seed from. */
  defaultInput: readonly number[];
}

// ── the sort family (each the real algorithm) ──

/** Bubble sort — repeatedly swap adjacent out-of-order pairs; stop early once a pass makes no swap. */
export function bubbleSort(a: TracedArray): void {
  for (let i = 0; i < a.length; i++) {
    let swapped = false;
    for (let j = 0; j < a.length - i - 1; j++) {
      a.cursor("j", j);
      if (a.compare(j, j + 1) > 0) {
        a.swap(j, j + 1);
        swapped = true;
      }
    }
    if (!swapped) break;
  }
  a.markSorted();
}

/** Insertion sort — grow a sorted prefix, swapping each new element down into place. */
export function insertionSort(a: TracedArray): void {
  for (let i = 1; i < a.length; i++) {
    a.cursor("i", i);
    let j = i;
    while (j > 0 && a.compare(j - 1, j) > 0) {
      a.swap(j - 1, j);
      j--;
    }
  }
  a.markSorted();
}

/** Quick sort — Lomuto partition around the last element, recurse each side. */
export function quickSort(a: TracedArray): void {
  const part = (lo: number, hi: number): void => {
    if (lo >= hi) return;
    a.mark(hi, "pivot"); // the pivot for this partition
    let i = lo;
    for (let j = lo; j < hi; j++) {
      a.cursor("j", j);
      if (a.compare(j, hi) < 0) {
        a.swap(i, j);
        i++;
      }
    }
    a.swap(i, hi); // drop the pivot into its final slot
    part(lo, i - 1);
    part(i + 1, hi);
  };
  part(0, a.length - 1);
  a.markSorted();
}

/** Heap sort — build a max-heap in place (sift-down), then swap the root to the end and re-sift. */
export function heapSort(a: TracedArray): void {
  const n = a.length;
  const siftDown = (start: number, end: number): void => {
    let root = start;
    while (root * 2 + 1 <= end) {
      let child = root * 2 + 1;
      if (child + 1 <= end && a.compare(child, child + 1) < 0) child += 1; // larger child
      if (a.compare(root, child) < 0) {
        a.swap(root, child);
        root = child;
      } else return;
    }
  };
  for (let start = Math.floor((n - 2) / 2); start >= 0; start--) siftDown(start, n - 1);
  for (let end = n - 1; end > 0; end--) {
    a.swap(0, end); // largest to the end
    siftDown(0, end - 1);
  }
  a.markSorted();
}

/** Merge sort — bottom-up: merge adjacent runs of growing width, writing the merged result back with
 *  `set` (so the animation shows the merge writes, distinct from the swap-based sorts). */
export function mergeSort(a: TracedArray): void {
  const n = a.length;
  for (let width = 1; width < n; width *= 2) {
    for (let lo = 0; lo < n; lo += 2 * width) {
      const mid = Math.min(lo + width, n);
      const hi = Math.min(lo + 2 * width, n);
      // Snapshot the two runs (silent reads), then write the merged order back into place.
      const left: number[] = [];
      const right: number[] = [];
      for (let k = lo; k < mid; k++) left.push(a.get(k));
      for (let k = mid; k < hi; k++) right.push(a.get(k));
      let i = 0;
      let j = 0;
      let k = lo;
      while (i < left.length && j < right.length) {
        if (left[i] <= right[j]) a.set(k++, left[i++]);
        else a.set(k++, right[j++]);
      }
      while (i < left.length) a.set(k++, left[i++]);
      while (j < right.length) a.set(k++, right[j++]);
    }
  }
  a.markSorted();
}

/** The visualizable algorithms, keyed by BASE NAME. The generic `sort` (the TypeScript kit's insertion
 *  sort) maps to insertion. Grows as more algorithms are authored as trace-programs (or, #3215 slice B,
 *  loaded from the impl's stored code). */
export const TRACE_PROGRAMS: Record<string, AlgoProgram> = {
  "bubble-sort": { run: bubbleSort, defaultInput: SORT_MOCK },
  "insertion-sort": { run: insertionSort, defaultInput: SORT_MOCK },
  "quick-sort": { run: quickSort, defaultInput: SORT_MOCK },
  "heap-sort": { run: heapSort, defaultInput: SORT_MOCK },
  "merge-sort": { run: mergeSort, defaultInput: SORT_MOCK },
  sort: { run: insertionSort, defaultInput: SORT_MOCK },
};

/** Normalize an impl id/name to its base-algorithm key — strip the extension, lowercase, and unify
 *  separators — so `merge-sort.rs`, `merge_sort`, and `merge-sort.ts` all resolve to `merge-sort`. */
export function programKey(impl: { id: string; name?: string }): string {
  return impl.id
    .replace(/\.[a-z0-9]+$/i, "") // drop the extension (".rs"/".ts")
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
}

/** The trace-program for an implementation, or `undefined` when the algorithm has none yet (so it simply
 *  shows no animation — never a wrong category one). */
export function programForImpl(impl: { id: string; name?: string }): AlgoProgram | undefined {
  return TRACE_PROGRAMS[programKey(impl)];
}
