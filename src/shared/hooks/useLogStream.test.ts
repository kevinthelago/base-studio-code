// useLogStream (#3638) — event-driven log reads.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";
import { useLogStream } from "@/shared/hooks/useLogStream";

// Capture each `listen(name, cb)` so a test can FIRE the stream-change event, and count unlistens.
const handlers: Record<string, () => void> = {};
let unlistened = 0;

beforeEach(() => {
  for (const k of Object.keys(handlers)) delete handlers[k];
  unlistened = 0;
  vi.mocked(listen).mockImplementation((name, cb) => {
    handlers[name] = () => (cb as (e: { payload: unknown }) => void)({ payload: null });
    return Promise.resolve(() => { unlistened++; });
  });
});


describe("useLogStream: the unlisten rejection is handled", () => {
  /** An unlisten that rejects the way Tauri's does, and REPORTS whether anyone attached a handler. */
  function rejectingUnlisten() {
    const state = { caught: false };
    const fn = () => {
      const p = Promise.reject(new Error("listener not found"));
      const realCatch = p.catch.bind(p);
      (p as unknown as { catch: unknown }).catch = (...a: Parameters<typeof realCatch>) => {
        state.caught = true;
        return realCatch(...a);
      };
      return p as unknown as void;
    };
    return { fn, state };
  }

  it("attaches a catch when unsubscribing on unmount", async () => {
    const { fn, state } = rejectingUnlisten();
    vi.mocked(listen).mockImplementation(() => Promise.resolve(fn as unknown as () => void));
    const { unmount } = renderHook(() => useLogStream("coord", () => {}));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { unmount(); });
    await new Promise((r) => setTimeout(r, 0));
    expect(state.caught).toBe(true);
  });

  it("attaches a catch on the CANCELLED path too", async () => {
    const { fn, state } = rejectingUnlisten();
    let resolveListen: ((un: () => void) => void) | undefined;
    vi.mocked(listen).mockImplementation(() => new Promise((res) => { resolveListen = res as (un: () => void) => void; }));
    const { unmount } = renderHook(() => useLogStream("coord", () => {}));
    unmount();
    resolveListen?.(fn as unknown as () => void);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(state.caught).toBe(true);
  });
});
