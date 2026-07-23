// useLogStream (#3638) — event-driven log reads.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";
import { useLogStream } from "./useLogStream";

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

describe("useLogStream (#3638)", () => {
  it("runs fn once on mount — the initial read", async () => {
    const fn = vi.fn();
    renderHook(() => useLogStream("coord", fn));
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
  });

  it("subscribes to the CANONICAL logs:// event and re-runs fn when it fires", async () => {
    const fn = vi.fn();
    renderHook(() => useLogStream("audit", fn)); // audit → tool
    await waitFor(() => expect(handlers["logs://tool"]).toBeTypeOf("function"));
    expect(fn).toHaveBeenCalledTimes(1); // just the mount read so far
    act(() => handlers["logs://tool"]());  // the stream changed
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2)); // re-read on the event
  });

  it("subscribes to EVERY stream when given several (re-reads on any)", async () => {
    const fn = vi.fn();
    renderHook(() => useLogStream(["done", "activity"], fn));
    await waitFor(() => {
      expect(handlers["logs://done"]).toBeTypeOf("function");
      expect(handlers["logs://activity"]).toBeTypeOf("function");
    });
    act(() => handlers["logs://activity"]());
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2)); // mount + the one event
  });

  it("does nothing while inactive — no read, no subscription", async () => {
    const fn = vi.fn();
    renderHook(() => useLogStream("coord", fn, [], { active: false }));
    await new Promise((r) => setTimeout(r, 0));
    expect(fn).not.toHaveBeenCalled();
    expect(handlers["logs://coord"]).toBeUndefined();
  });

  it("unsubscribes on unmount", async () => {
    const { unmount } = renderHook(() => useLogStream("coord", vi.fn()));
    await waitFor(() => expect(handlers["logs://coord"]).toBeTypeOf("function"));
    unmount();
    await waitFor(() => expect(unlistened).toBe(1));
  });
});
