// The streaming engine (#3176) — the testable heart. Covers the four guarantees: LAZY pull (the
// generator advances exactly once per `next`), RING-BUFFER eviction, deterministic REPLAY when scrubbing
// older than the window, and seek (buffered back, replay back, forward-with-clamp).
import { describe, it, expect } from "vitest";
import { makeTraceStream } from "./traceStream";
import type { Frame } from "./trace";

const arr = (n: number): Frame => ({ structure: "array", data: [n] });

/** A factory whose generator yields `count` array frames [0..count-1], instrumented so a test can see
 *  exactly how many frames were pulled (`yields`) and how many times the factory was re-run (`calls` —
 *  each deterministic replay re-invokes it). */
function instrumented(count = 6) {
  const state = { calls: 0, yields: 0 };
  const factory = (): Generator<Frame> => {
    state.calls++;
    return (function* () {
      for (let i = 0; i < count; i++) {
        state.yields++;
        yield arr(i);
      }
    })();
  };
  return { factory, state };
}

describe("makeTraceStream (#3176)", () => {
  it("pulls lazily — the generator advances exactly once per next(), never eagerly", () => {
    const { factory, state } = instrumented();
    const s = makeTraceStream(factory);

    // Constructing the stream creates the generator but runs no body → nothing pulled.
    expect(state.calls).toBe(1);
    expect(state.yields).toBe(0);
    expect(s.current()).toBeNull();
    expect(s.index()).toBe(-1);

    expect(s.next()).toEqual(arr(0));
    expect(state.yields).toBe(1); // exactly one pull
    s.next();
    s.next();
    expect(state.yields).toBe(3); // one pull per next()
    expect(s.index()).toBe(2);
    expect(s.current()).toEqual(arr(2));
  });

  it("scrubs back within the window for free — no re-pull, no replay", () => {
    const { factory, state } = instrumented();
    const s = makeTraceStream(factory); // default 500-frame window
    s.next();
    s.next();
    s.next(); // produced 0,1,2

    expect(s.seek(0)).toEqual(arr(0));
    expect(state.yields).toBe(3); // still buffered — no new pulls
    expect(state.calls).toBe(1); // no replay
    expect(s.index()).toBe(0);

    // Stepping forward again re-reads the buffer, still no pull.
    expect(s.next()).toEqual(arr(1));
    expect(state.yields).toBe(3);
    expect(s.index()).toBe(1);
  });

  it("evicts the oldest once past capacity, and REPLAYS deterministically to reach an evicted index", () => {
    const { factory, state } = instrumented();
    const s = makeTraceStream(factory, { bufferSize: 3 });
    for (let i = 0; i < 6; i++) s.next(); // produce 0..5 → window holds {3,4,5}

    expect(state.yields).toBe(6);
    expect(state.calls).toBe(1);
    expect(s.index()).toBe(5);

    // An index still in the window → free, no replay.
    expect(s.seek(4)).toEqual(arr(4));
    expect(state.calls).toBe(1);

    // An EVICTED index (older than the window) → deterministic replay from the start.
    expect(s.seek(1)).toEqual(arr(1));
    expect(state.calls).toBe(2); // factory re-run
    expect(s.index()).toBe(1);

    // The replayed window is intact: stepping forward continues correctly off the fresh generator.
    expect(s.next()).toEqual(arr(2));
    expect(s.index()).toBe(2);
  });

  it("seeks forward past the frontier by pulling, and clamps past the end of the trace", () => {
    const { factory } = instrumented(6);
    const s = makeTraceStream(factory);

    expect(s.seek(3)).toEqual(arr(3)); // pulls 0..3
    expect(s.index()).toBe(3);

    // Past the last frame (index 5) → clamp to the last, not null.
    expect(s.seek(99)).toEqual(arr(5));
    expect(s.index()).toBe(5);
    expect(s.atEnd()).toBe(true);
  });

  it("reports end-of-trace via next()===null (cursor holds) and atEnd()", () => {
    const { factory } = instrumented(2);
    const s = makeTraceStream(factory);
    expect(s.next()).toEqual(arr(0));
    expect(s.next()).toEqual(arr(1));
    expect(s.atEnd()).toBe(false); // exhausted not yet observed (haven't pulled past the end)
    expect(s.next()).toBeNull(); // end — one more pull observes done
    expect(s.index()).toBe(1); // cursor stayed on the last frame
    expect(s.atEnd()).toBe(true);
  });

  it("seek(i<0) parks the cursor before the start (current null)", () => {
    const { factory } = instrumented();
    const s = makeTraceStream(factory);
    s.next();
    s.next();
    expect(s.seek(-1)).toBeNull();
    expect(s.index()).toBe(-1);
    expect(s.current()).toBeNull();
  });

  it("handles an empty trace", () => {
    const s = makeTraceStream(function* (): Generator<Frame> {});
    expect(s.next()).toBeNull();
    expect(s.current()).toBeNull();
    expect(s.index()).toBe(-1);
    expect(s.seek(0)).toBeNull();
  });
});
