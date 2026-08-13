// #the-scan-cache-stops-spawning-a-process-per-batch — the write-behind rule.
//
// The regression this guards leaves the stored data perfectly correct and simply costs ~400 process spawns
// per sweep (measured: 157.1s). Nothing about the result would reveal it, so the assertions here are about
// the WRITE COUNT — the same shape as #4132's store-commit-count test one layer down.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeBatchWriter } from "./batchWriter";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("makeBatchWriter", () => {
  it("collapses many queues into ONE write per window", () => {
    const write = vi.fn();
    const w = makeBatchWriter<number>(write, 5_000);
    for (let i = 0; i < 40; i++) w.queue({ [`c${i}`]: i });

    expect(write).not.toHaveBeenCalled();          // nothing yet — this is the fix
    vi.advanceTimersByTime(5_000);
    expect(write).toHaveBeenCalledTimes(1);        // was 40 spawns before
    expect(Object.keys(write.mock.calls[0][0])).toHaveLength(40);
  });

  it("keeps the LATEST value for a key queued twice in one window", () => {
    // A component scanned twice inside one window is one write carrying its latest result — not two,
    // and certainly not one carrying the stale one.
    const write = vi.fn();
    const w = makeBatchWriter<string>(write, 1_000);
    w.queue({ a: "old" });
    w.queue({ a: "new", b: "x" });
    vi.advanceTimersByTime(1_000);
    expect(write).toHaveBeenCalledWith({ a: "new", b: "x" });
  });

  it("ARMS on the first queue rather than resetting — a debounce would never fire mid-sweep", () => {
    // The trap: `timer = setTimeout(...)` on every queue restarts the clock, so a steady stream of
    // results (exactly what a sweep is) defers the write until the stream STOPS. Here the window is
    // honoured from the first entry.
    const write = vi.fn();
    const w = makeBatchWriter<number>(write, 1_000);
    w.queue({ a: 1 });
    vi.advanceTimersByTime(600);
    w.queue({ b: 2 });                  // arrives mid-window
    vi.advanceTimersByTime(400);        // …the ORIGINAL window elapses
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith({ a: 1, b: 2 });
  });

  it("writes again for the NEXT window — one slow write per window, not one ever", () => {
    const write = vi.fn();
    const w = makeBatchWriter<number>(write, 1_000);
    w.queue({ a: 1 });
    vi.advanceTimersByTime(1_000);
    w.queue({ b: 2 });
    vi.advanceTimersByTime(1_000);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1][0]).toEqual({ b: 2 });
  });

  it("flush() writes what the clock has not reached, and disarms", () => {
    // The teardown case. Those results really happened and their signatures are already marked scanned,
    // so dropping them would leave work that never re-queues AND never reaches the sink.
    const write = vi.fn();
    const w = makeBatchWriter<number>(write, 5_000);
    w.queue({ a: 1 });
    w.flush();
    expect(write).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_000);
    expect(write).toHaveBeenCalledTimes(1);   // the armed timer was cancelled, not left to double-write
  });

  it("flush() with nothing pending writes NOTHING — no spawn for no work", () => {
    const write = vi.fn();
    makeBatchWriter<number>(write, 1_000).flush();
    expect(write).not.toHaveBeenCalled();
  });

  it("reports what is waiting", () => {
    const w = makeBatchWriter<number>(vi.fn(), 1_000);
    expect(w.pending()).toBe(0);
    w.queue({ a: 1, b: 2 });
    expect(w.pending()).toBe(2);
    w.flush();
    expect(w.pending()).toBe(0);
  });
});
