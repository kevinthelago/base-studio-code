// The seeded array-sort proof (#3177, epic #3171) — the in-app example that proves the whole
// visualization seam end to end: a step-yielding generator → the streaming <TracePlayer> (#3176) →
// the <ArrayView> renderer (#3178) → `data-op` states → the designed compare/swap/set animations.
//
// GENERATOR-AS-SOURCE (#3171 decision 3): the algorithm's implementation IS the trace. `sortSteps`
// mutates its array in place and yields a snapshot `ArrayFrame` per step; the plain `sort` DRAINS the
// same generator to order the array (one source of truth), and the visualizer animates the yields.
//
// PURITY / REPLAY CONTRACT: `sortSteps` MUTATES the array it is handed (that is what lets `sort` drain
// it). The streaming engine (`makeTraceStream`) requires a factory that yields the IDENTICAL sequence on
// every call — it re-invokes the factory for deterministic scrub/replay. So a replaying call site must
// hand `sortSteps` a FRESH COPY of its fixed input, never a shared array. The viz registry does exactly
// that (`() => sortSteps([...SORT_MOCK])`), keeping the module-level {@link SORT_MOCK} immutable.

import type { ArrayFrame } from "../../lib/trace";

/** A small, watchable mock input for the sort proof — short enough to teach, unsorted enough that the
 *  compare/swap animations have visible work to do. Treated as IMMUTABLE: hand `sortSteps` a copy of it
 *  (the generator mutates in place), or replay would start from an already-sorted array. */
export const SORT_MOCK: readonly number[] = [5, 2, 9, 1, 6, 3, 8, 4, 7];

/**
 * Insertion sort authored as a step-yielding generator (#3171 generator-as-source). MUTATES `a` in place
 * and yields one snapshot {@link ArrayFrame} per step:
 * - a `compare` verb on the two neighbours before each comparison,
 * - a `swap` verb on the pair after each out-of-order exchange,
 * - the `i` / `j` cursors so the renderer can draw the outer/inner pointers,
 * - and a terminal frame that `mark`s every cell `sorted`.
 *
 * The yielded sequence is non-worsening by inversion count and terminates fully sorted — each `swap`
 * removes exactly one inversion, every other frame preserves the order — which is what the `sortSteps`
 * test asserts. Snapshots are fresh copies (`[...a]`) so each frame is an immutable view of that step.
 */
export function* sortSteps(a: number[]): Generator<ArrayFrame> {
  yield { structure: "array", data: [...a] };
  for (let i = 1; i < a.length; i++) {
    let j = i;
    while (j > 0) {
      // The transient `compare` verb on the two neighbours (j-1, j).
      yield { structure: "array", data: [...a], ops: [{ op: "compare", at: [j - 1, j] }], cursors: { i, j } };
      if ((a[j - 1] as number) <= (a[j] as number)) break;
      // Out of order → exchange, then emit the `swap` verb on the same pair.
      const t = a[j - 1];
      a[j - 1] = a[j];
      a[j] = t;
      yield { structure: "array", data: [...a], ops: [{ op: "swap", at: [j - 1, j] }], cursors: { i, j } };
      j--;
    }
  }
  // Terminal frame: every cell has reached its sorted position (a durable `sorted` mark on each).
  yield {
    structure: "array",
    data: [...a],
    ops: a.map((_, k) => ({ op: "mark", at: k, as: "sorted" as const })),
  };
}

/**
 * Sort `input` ascending by DRAINING {@link sortSteps} (generator-as-source, #3171) — the same generator
 * that animates the visualization also computes the result, so there is one source of truth. PURE:
 * operates on a copy and never mutates `input`.
 */
export const sort = (input: readonly number[]): number[] => {
  const a = [...input];
  const steps = sortSteps(a);
  // Draining the generator runs every step; `sortSteps` mutates `a` in place as it goes.
  while (!steps.next().done) {
    /* drain */
  }
  return a;
};
