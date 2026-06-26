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
});
