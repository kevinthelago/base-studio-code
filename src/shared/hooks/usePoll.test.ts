import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { usePoll } from "./usePoll";

describe("usePoll", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs immediately then every ms", () => {
    const fn = vi.fn();
    renderHook(() => usePoll(fn, 1000));
    expect(fn).toHaveBeenCalledTimes(1); // immediate
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(4); // + 3 ticks
  });

  it("skips the immediate run with { immediate: false }", () => {
    const fn = vi.fn();
    renderHook(() => usePoll(fn, 1000, [], { immediate: false }));
    expect(fn).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("stops ticking after unmount and reports cancellation to in-flight callbacks", () => {
    let lastIsCancelled: (() => boolean) | null = null;
    const fn = vi.fn((isCancelled: () => boolean) => { lastIsCancelled = isCancelled; });
    const { unmount } = renderHook(() => usePoll(fn, 1000));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(lastIsCancelled!()).toBe(false);
    unmount();
    expect(lastIsCancelled!()).toBe(true); // the captured signal flips on cleanup
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(1); // no ticks after unmount
  });

  it("does not re-subscribe when only the callback identity changes", () => {
    const a = vi.fn();
    const { rerender } = renderHook(({ f }) => usePoll(f, 1000), { initialProps: { f: a } });
    expect(a).toHaveBeenCalledTimes(1);
    const b = vi.fn();
    rerender({ f: b }); // new fn, same deps → interval not restarted, no extra immediate run
    expect(b).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(1000);
    expect(b).toHaveBeenCalledTimes(1); // next tick uses the latest fn
  });

  it("does NOT re-enter while a previous async run is still pending (#3666)", async () => {
    let resolve: (() => void) | null = null;
    const fn = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    renderHook(() => usePoll(fn, 1000));
    expect(fn).toHaveBeenCalledTimes(1); // immediate run — now pending

    // Ticks fire while the run is still pending → SKIPPED, so overlapping runs never pile up.
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(1); // still just the one in-flight run, not 4

    // Once it settles, the `running` guard clears (its finally microtask) and the next tick runs.
    resolve!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("a SYNC (void-returning) poller is unaffected — it still fires every tick", () => {
    const fn = vi.fn(); // returns undefined, not a promise → guard never engages
    renderHook(() => usePoll(fn, 1000));
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(4); // immediate + 3 ticks, exactly as before
  });
});
