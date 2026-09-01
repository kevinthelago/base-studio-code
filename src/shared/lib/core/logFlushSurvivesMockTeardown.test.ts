// THE FAILURE THIS PINS turned a gate red with EVERY TEST PASSING:
//
//   Test Files  755 passed (755)
//        Tests  7095 passed (7095)
//       Errors  1 error
//   TypeError: Cannot read properties of undefined (reading 'catch')
//    ❯ Timeout.drain [as _onTimeout] src/shared/lib/core/log.ts
//
// `drain` runs from a TIMER, so nothing is on the stack to contain a throw. A test that tears down the
// Tauri mock leaves `invoke` returning `undefined`; `.catch` on that raises synchronously, escapes as an
// uncaught exception, and is attributed to whichever test happened to be running nearby — a red run with
// nothing failing, which teaches the reader that red is noise.
//
// The module's own comment already promised the swallow ("so logging never breaks flow"); it just did not
// cover the synchronous half.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("the deferred log flush survives its backend disappearing", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("@tauri-apps/api/core");
  });

  /** Drive a scheduled flush with `invoke` returning `bad`, and report anything it throws. */
  const flushWith = async (bad: unknown): Promise<unknown> => {
    vi.doMock("@tauri-apps/api/core", () => ({ invoke: () => bad }));
    const { log } = await import("@/shared/lib/core/log");
    log.error("a message that must reach the queue", "test");
    try {
      vi.advanceTimersByTime(1000); // past FLUSH_MS
      return null;
    } catch (e) {
      return e;
    }
  };

  it("does not throw when the mock is gone and `invoke` returns undefined", async () => {
    // THE REPORTED CASE, exactly: a torn-down mock returns undefined.
    expect(await flushWith(undefined)).toBeNull();
  });

  it("does not throw when `invoke` returns a non-thenable", async () => {
    // Same hazard, one step out: anything without `.then` breaks a bare `.catch()` chain.
    expect(await flushWith(null)).toBeNull();
    expect(await flushWith(42)).toBeNull();
    expect(await flushWith({ notAPromise: true })).toBeNull();
  });

  it("does not throw when `invoke` itself throws synchronously", async () => {
    vi.doMock("@tauri-apps/api/core", () => ({
      invoke: () => {
        throw new Error("backend gone");
      },
    }));
    const { log } = await import("@/shared/lib/core/log");
    log.error("scheduled before the backend vanished", "test");
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
  });

  it("STILL DELIVERS when the backend is healthy — the guard is not a silent no-op", async () => {
    // Non-vacuity: every assertion above is about NOT throwing, which a `drain` that did nothing at all
    // would also satisfy.
    const invoke = vi.fn().mockResolvedValue(null);
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    const { log } = await import("@/shared/lib/core/log");
    log.error("must actually be sent", "test");
    vi.advanceTimersByTime(1000);
    expect(invoke).toHaveBeenCalledWith(
      "frontend_log",
      expect.objectContaining({ message: "must actually be sent" }),
    );
  });
});
