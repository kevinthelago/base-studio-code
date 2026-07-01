import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useScheduler } from "./useScheduler";
import { dueAutomations } from "./lib/scheduler";

// Mock the pure lib so we can assert tick cadence without real automations/dispatch.
vi.mock("./lib/scheduler", () => ({ dueAutomations: vi.fn(() => []) }));
vi.mock("./lib/dispatch", () => ({ dispatchAutomation: vi.fn() }));

describe("useScheduler", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.mocked(dueAutomations).mockClear(); });
  afterEach(() => vi.useRealTimers());

  it("does NOT check immediately — the first tick is the ~1s hydration grace", () => {
    renderHook(() => useScheduler());
    expect(dueAutomations).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(dueAutomations).toHaveBeenCalledTimes(1); // grace tick
  });

  it("then checks on the 20s interval", () => {
    renderHook(() => useScheduler());
    vi.advanceTimersByTime(1000);   // grace
    expect(dueAutomations).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(20_000); // first interval tick (immediate:false → at TICK_MS)
    expect(dueAutomations).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(20_000);
    expect(dueAutomations).toHaveBeenCalledTimes(3);
  });

  it("stops ticking after unmount", () => {
    const { unmount } = renderHook(() => useScheduler());
    vi.advanceTimersByTime(1000);
    expect(dueAutomations).toHaveBeenCalledTimes(1);
    unmount();
    vi.advanceTimersByTime(60_000);
    expect(dueAutomations).toHaveBeenCalledTimes(1); // no further ticks
  });
});
