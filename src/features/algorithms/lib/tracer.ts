// The instrumented-execution tracer (#3216, epic #3215) — the mechanism that makes the ACTUAL algorithm
// code drive the animation. Instead of hand-authoring a trace per algorithm, the algorithm runs against a
// TracedArray whose operations are observable: every `compare`/`swap`/`set`/`mark` records a
// StructureFrame, so the animation is DERIVED from the algorithm's real execution. Each algorithm looks
// different because it IS different (bubble's adjacent swaps vs merge's writes vs quick's partitions).
//
// The algorithm is its real logic written against this structure (see viz/examples/sorts.ts) — no `yield`,
// no hand-drawn frames. `runAlgorithm` seeds the structure, runs the algorithm, and exposes the recorded
// trace as a fresh generator per call (replay-safe for the streaming player). Reads via `get` are SILENT
// (the algorithm's internal logic); only meaningful operations record a frame.
//
// This is the array tracer; TracedMatrix / TracedGraph / TracedTree follow the same shape as their
// renderers land (#3179–#3185), so instrumented execution generalizes to every data type.
import type { ArrayFrame, ArrayOp, Frame } from "./trace";

/** A durable per-cell mark an algorithm can set (matches the ArrayOp `mark` vocabulary). */
export type ArrayMark = "sorted" | "pivot" | "min";

/**
 * An instrumented array — the algorithm operates on it, and every observable operation appends an
 * `ArrayFrame` to the trace. `get` is a silent read (internal logic); `compare`/`swap`/`set`/`mark` are
 * the visible verbs the `<ArrayView>` renderer animates. `cursor` moves a named pointer (drawn on the
 * next frame). Values are numbers (the sort family); the frame carries a fresh snapshot each op.
 */
export class TracedArray {
  private readonly a: number[];
  private readonly log: ArrayFrame[] = [];
  private readonly cur: Record<string, number> = {};

  constructor(input: readonly number[]) {
    this.a = [...input];
    this.emit(); // the initial frame — the input at rest
  }

  /** The length — read freely (no frame). */
  get length(): number {
    return this.a.length;
  }

  /** A silent read of index `i` (the algorithm's internal logic — records no frame). */
  get(i: number): number {
    return this.a[i];
  }

  /** Compare indices `i` and `j` — records a `compare` frame; returns sign(a[i] - a[j]) (`-1|0|1`). */
  compare(i: number, j: number): number {
    this.emit([{ op: "compare", at: [i, j] }]);
    return Math.sign(this.a[i] - this.a[j]);
  }

  /** Swap indices `i` and `j` in place — records a `swap` frame. */
  swap(i: number, j: number): void {
    const t = this.a[i];
    this.a[i] = this.a[j];
    this.a[j] = t;
    this.emit([{ op: "swap", at: [i, j] }]);
  }

  /** Write `v` at index `i` — records a `set` frame. */
  set(i: number, v: number): void {
    this.a[i] = v;
    this.emit([{ op: "set", at: i }]);
  }

  /** Move a named cursor (an `i`/`j` pointer the renderer draws); `null` clears it. Rides the next frame. */
  cursor(name: string, i: number | null): void {
    if (i == null) delete this.cur[name];
    else this.cur[name] = i;
  }

  /** Mark one cell with a durable state (`pivot`/`min`/`sorted`) — records a `mark` frame. */
  mark(i: number, as: ArrayMark): void {
    this.emit([{ op: "mark", at: i, as }]);
  }

  /** Terminal frame — mark every cell `sorted` (the settled resting state a sort ends on). */
  markSorted(): void {
    this.emit(this.a.map((_, k) => ({ op: "mark", at: k, as: "sorted" as const })));
  }

  /** The recorded trace (a fresh snapshot array). */
  trace(): ArrayFrame[] {
    return [...this.log];
  }

  private emit(ops?: ArrayOp[]): void {
    const frame: ArrayFrame = { structure: "array", data: [...this.a] };
    if (ops && ops.length) frame.ops = ops;
    if (Object.keys(this.cur).length) frame.cursors = { ...this.cur };
    this.log.push(frame);
  }
}

/**
 * Run an algorithm — a plain function over a {@link TracedArray} — on `input`, returning a factory that
 * yields its recorded trace as a FRESH generator each call. The factory is a stable identity (bind it once
 * at the call site) so the streaming player can replay it deterministically; each call re-runs the
 * algorithm from scratch (pure over `input`, which is never mutated).
 */
export function runAlgorithm(algo: (a: TracedArray) => void, input: readonly number[]): () => Generator<Frame> {
  return function* () {
    const a = new TracedArray(input);
    algo(a);
    yield* a.trace();
  };
}
