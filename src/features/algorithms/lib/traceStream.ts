// The trace streaming engine (#3176, epic #3171) — a lazy, bounded, scrub-able cursor over a trace
// `Generator<Frame>`. PURE + React-free (the testable heart; `<TracePlayer>` is a thin React driver on top).
//
// The trace is a LAZY generator pulled at play speed (not pushed to a queue) — O(1) memory + automatic
// backpressure: the generator is suspended between yields and only produces the next frame when the
// player pulls it. A 100k-step run never materializes 100k frames — only the current frame + the
// generator's own suspended state (O(input)) are held.
//
//   • Scrub-back: a bounded RING BUFFER (~500 frames) keeps the recent window, so stepping back is free.
//   • Scrub OLDER than the window: DETERMINISTIC REPLAY — the trace is a pure function of the input, so
//     we re-run the factory from the start to the target index and rebuild the window. Cheap + exact.
//
// The real limit is watchability, not memory (cap mock-input size upstream; this engine just streams).

import type { Frame } from "./trace";

/** Default recent-window size — how many trailing frames stay buffered for free scrub-back (#3171). */
export const DEFAULT_BUFFER_SIZE = 500;

export interface TraceStreamOptions {
  /** Ring-buffer capacity — the recent-window size for scrub-back. Default {@link DEFAULT_BUFFER_SIZE}.
   *  Scrubbing older than this replays the generator from the start (deterministic + cheap). */
  bufferSize?: number;
}

/**
 * A cursor over a trace. `next` advances one frame (pulling from the live generator at the frontier, or
 * re-reading the buffer after a scrub-back); `seek` jumps to an absolute index (buffered → free, older
 * than the window → deterministic replay, past the frontier → pulls forward, clamping at the end).
 * `current`/`index` read the cursor. Before the first advance the cursor is at -1 and `current` is null.
 */
export interface TraceStream {
  /** The frame at the cursor, or null before the first advance / when the trace is empty. */
  current(): Frame | null;
  /** Advance one frame and return it, or null at the end of the trace (the cursor stays put). */
  next(): Frame | null;
  /** Jump to absolute index `i` and return that frame (clamped to `[0, last]`; `i < 0` → null cursor). */
  seek(i: number): Frame | null;
  /** The current absolute frame index (-1 before the first advance). */
  index(): number;
  /** Whether the generator is exhausted AND the cursor sits on the last frame (nothing more to pull). */
  atEnd(): boolean;
}

/**
 * A fixed-capacity ring buffer keyed by ABSOLUTE frame index. Every absolute index `i` lives in slot
 * `i % capacity` (guaranteed because pushes are strictly sequential from `clear`), so `get(i)` is O(1)
 * and eviction is just advancing `start`. Holds the window `[start, start + count)`.
 */
class Ring {
  private buf: (Frame | undefined)[];
  private start = 0; // absolute index of the oldest retained frame
  private count = 0; // number retained (≤ capacity)

  constructor(readonly capacity: number) {
    this.buf = new Array(capacity);
  }

  /** Append the next sequential frame; evict the oldest once full. */
  push(frame: Frame): void {
    this.buf[(this.start + this.count) % this.capacity] = frame;
    if (this.count < this.capacity) this.count++;
    else this.start++; // full → evict the oldest by advancing the window
  }

  /** Absolute index of the oldest retained frame. */
  get firstIndex(): number {
    return this.start;
  }

  /** Absolute index the NEXT push will occupy (== count of frames ever produced this run). */
  get nextIndex(): number {
    return this.start + this.count;
  }

  /** Is absolute index `i` still in the window? */
  has(i: number): boolean {
    return i >= this.start && i < this.start + this.count;
  }

  /** The frame at absolute index `i`, or undefined if evicted / not yet produced. */
  get(i: number): Frame | undefined {
    return this.has(i) ? this.buf[i % this.capacity] : undefined;
  }

  /** Reset to empty at absolute index 0 (for a replay from the start). */
  clear(): void {
    this.start = 0;
    this.count = 0;
  }
}

/**
 * Build a {@link TraceStream} over a trace generator `factory`. The factory is called ONCE up front
 * (creating a suspended generator — no frames produced yet) and AGAIN on each deterministic replay, so
 * it must yield the identical frame sequence every call (a pure function of its captured input).
 *
 * @param factory  Produces a fresh `Generator<Frame>` from the algorithm's fixed input.
 * @param opts     {@link TraceStreamOptions} — the scrub-back window size.
 */
export function makeTraceStream(
  factory: () => Generator<Frame>,
  opts: TraceStreamOptions = {},
): TraceStream {
  const capacity = Math.max(1, Math.floor(opts.bufferSize ?? DEFAULT_BUFFER_SIZE));
  const ring = new Ring(capacity);
  let gen = factory(); // suspended — no body runs until the first pull
  let cursor = -1; // current absolute index; -1 before the first frame
  let exhausted = false; // the live generator has reported done

  /** Pull ONE frame from the live generator into the ring, or null when exhausted. */
  function pull(): Frame | null {
    if (exhausted) return null;
    const r = gen.next();
    if (r.done) {
      exhausted = true;
      return null;
    }
    ring.push(r.value);
    return r.value;
  }

  /** Re-run the factory from scratch and pull forward to absolute index `i` (deterministic replay),
   *  clamping the cursor to the last frame if the trace is shorter than `i`. */
  function replayTo(i: number): Frame | null {
    gen = factory();
    ring.clear();
    exhausted = false;
    for (let k = 0; k <= i; k++) {
      if (pull() == null) break; // trace shorter than i → stop at the end
    }
    cursor = ring.nextIndex - 1; // == min(i, produced-1)
    return current();
  }

  function current(): Frame | null {
    return cursor < 0 ? null : ring.get(cursor) ?? null;
  }

  function next(): Frame | null {
    const target = cursor + 1;
    // Already buffered (we had scrubbed back) → no pull.
    if (target < ring.nextIndex) {
      cursor = target;
      return current();
    }
    // At the frontier → pull exactly one fresh frame.
    const frame = pull();
    if (frame == null) return null; // end of trace — cursor stays put
    cursor = target;
    return frame;
  }

  function seek(i: number): Frame | null {
    if (i < 0) {
      cursor = -1;
      return null;
    }
    if (ring.has(i)) {
      cursor = i;
      return current();
    }
    // Older than the retained window → deterministic replay from the start.
    if (i < ring.firstIndex) return replayTo(i);
    // Past the frontier → pull forward, clamping at the end of the trace.
    while (ring.nextIndex <= i && !exhausted) pull();
    cursor = Math.min(i, ring.nextIndex - 1);
    return current();
  }

  return {
    current,
    next,
    seek,
    index: () => cursor,
    atEnd: () => exhausted && cursor === ring.nextIndex - 1,
  };
}
