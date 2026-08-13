// #graph-health-stops-blocking-first-paint — idle scheduling.
//
// Two properties matter more than the happy path, and both are about work that must still HAPPEN:
//   · a missing `requestIdleCallback` must fall back, not silently drop the work (jsdom, some shells)
//   · a starved main thread must not defer forever, which is why the timeout is passed
// The third is cancellation, because a superseded computation landing after its inputs changed is how a
// deferred derivation shows the wrong answer.
import { describe, it, expect, vi, afterEach } from "vitest";
import { runWhenIdle, IDLE_TIMEOUT_MS } from "./idle";

type IdleGlobal = {
  requestIdleCallback?: unknown;
  cancelIdleCallback?: unknown;
};
const g = globalThis as IdleGlobal;

afterEach(() => {
  delete g.requestIdleCallback;
  delete g.cancelIdleCallback;
  vi.useRealTimers();
});

describe("runWhenIdle with requestIdleCallback available", () => {
  it("schedules through it, and passes a TIMEOUT so busy work cannot starve forever", () => {
    // The timeout is the whole reason this is safe to use for work that must happen: the page is at its
    // busiest exactly when the deferred work was queued.
    const ric = vi.fn().mockReturnValue(42);
    g.requestIdleCallback = ric;
    const fn = vi.fn();

    runWhenIdle(fn);
    expect(ric).toHaveBeenCalledTimes(1);
    expect(ric.mock.calls[0][0]).toBe(fn);
    expect(ric.mock.calls[0][1]).toEqual({ timeout: IDLE_TIMEOUT_MS });
  });

  it("honours a caller-supplied timeout", () => {
    const ric = vi.fn().mockReturnValue(1);
    g.requestIdleCallback = ric;
    runWhenIdle(() => {}, 999);
    expect(ric.mock.calls[0][1]).toEqual({ timeout: 999 });
  });

  it("cancels by handle", () => {
    g.requestIdleCallback = vi.fn().mockReturnValue(7);
    const cancel = vi.fn();
    g.cancelIdleCallback = cancel;

    runWhenIdle(() => {})();
    expect(cancel).toHaveBeenCalledWith(7);
  });

  it("does not throw when the platform offers request but not cancel", () => {
    // A real shape in the wild — the optional-call is what keeps a cleanup from crashing an unmount.
    g.requestIdleCallback = vi.fn().mockReturnValue(3);
    expect(() => runWhenIdle(() => {})()).not.toThrow();
  });
});

describe("runWhenIdle without requestIdleCallback (jsdom, older shells)", () => {
  it("still RUNS the work, via a timeout — the fallback is not a no-op", () => {
    // The load-bearing case. Degrading to "never computed" would trade a performance win for a missing
    // feature: the badges would simply never appear where the API is absent.
    vi.useFakeTimers();
    const fn = vi.fn();
    runWhenIdle(fn);
    expect(fn).not.toHaveBeenCalled();   // deferred, not synchronous — first paint still comes first
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("cancels the timeout, so a superseded computation never lands", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    runWhenIdle(fn)();
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS * 10);
    expect(fn).not.toHaveBeenCalled();
  });
});
