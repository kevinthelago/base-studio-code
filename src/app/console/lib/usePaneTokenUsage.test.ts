/**
 * @vitest-environment jsdom
 *
 * This file lives under `lib/`, which vitest's `node` project covers, but it genuinely needs a DOM.
 * A per-file docblock beats the project's environment, so the requirement is stated where a reader
 * meets it. See the `projects` split in vitest.config.ts for why the default is `node` here.
 */
// #4074 — the per-pane cost poll must NOT spawn a `bsc` subprocess.
//
// It polls every 4s and was the app's single biggest spawner (415 calls in a 27-minute window). Each
// spawn ran on Tauri's main thread through the sync `bsc` command, so the invoke queue backed up to
// 25s and unrelated commands — including `perf_record_frontend_sample`, which does almost nothing —
// waited behind it. #3630 moved the other hot pollers in-process and left this one on the bridge as
// "low-frequency"; it never was.
//
// This asserts the CHANNEL, not the parsing: which command the poll issues is the whole fix, and a
// well-meaning revert to `bscJson(["logs","cost",…])` would restore the stall while every other test
// still passed.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { usePaneTokenUsage } from "@/app/console/lib/usePaneTokenUsage";

const invoked = vi.mocked(invoke);

beforeEach(() => {
  invoked.mockReset();
  invoked.mockResolvedValue([]);
});

describe("usePaneTokenUsage — reads in-process, never through the bsc bridge (#4074)", () => {
  it("invokes `logs_usage` and never the `bsc` sidecar", async () => {
    renderHook(() => usePaneTokenUsage(64));
    await waitFor(() => expect(invoked).toHaveBeenCalled());

    const cmds = invoked.mock.calls.map(([cmd]) => cmd);
    expect(cmds).toContain("logs_usage");
    // The regression this guards: any `bsc` invoke here is a process spawn on the main thread.
    expect(cmds).not.toContain("bsc");
  });

  it("passes the limit through, so the read stays bounded", async () => {
    renderHook(() => usePaneTokenUsage(8));
    await waitFor(() => expect(invoked).toHaveBeenCalled());
    const call = invoked.mock.calls.find(([cmd]) => cmd === "logs_usage");
    expect(call?.[1]).toEqual({ limit: 8 });
  });

  it("degrades to an empty map when the read fails, rather than throwing into the console", async () => {
    invoked.mockRejectedValue(new Error("no log dir"));
    const { result } = renderHook(() => usePaneTokenUsage());
    await waitFor(() => expect(invoked).toHaveBeenCalled());
    expect(result.current.size).toBe(0);
  });
});

// ONE POLLER FOR THE WHOLE APP (#one-poller-per-datum-not-one-per-consumer).
//
// The value is a map of EVERY pane built from ONE call, so the data is global and polling it per
// consumer is pure duplication. It was instantiated in `consolepage` AND in `telemetryview` — a PANE
// view, rendered once per pane showing it — so each extra Telemetry pane added another 4s poll of the
// single most expensive read in the app (655 calls / 324.8s measured in one session).
describe("usePaneTokenUsage — one shared poller, however many consumers", () => {
  const usageCalls = () => invoked.mock.calls.filter(([cmd]) => cmd === "logs_usage").length;

  it("issues ONE invoke for three consumers, not three", async () => {
    invoked.mockResolvedValue([]);
    renderHook(() => usePaneTokenUsage(64));
    renderHook(() => usePaneTokenUsage(64));
    renderHook(() => usePaneTokenUsage(64));
    await waitFor(() => expect(usageCalls()).toBeGreaterThan(0));
    // The whole point: consumer count must not multiply the read.
    expect(usageCalls()).toBe(1);
  });

  it("gives a late consumer the current value immediately instead of a blank 4s", async () => {
    const row = {
      pane: "studio-code:director", session_id: "s", model: "claude", input_tokens: 1,
      output_tokens: 2, cache_creation_tokens: 0, cache_read_tokens: 0, cost_usd: 0.5,
    };
    invoked.mockResolvedValue([row]);
    const first = renderHook(() => usePaneTokenUsage(64));
    await waitFor(() => expect(first.result.current.size).toBe(1));

    // A pane opened later must render populated on its FIRST frame — it shares the poller, so it
    // would otherwise wait a whole interval for a value that is already in hand.
    const late = renderHook(() => usePaneTokenUsage(64));
    expect(late.result.current.get("studio-code:director")?.cost_usd).toBe(0.5);
    expect(usageCalls()).toBe(1); // and joining must not trigger a fetch of its own
  });

  it("polls the LARGEST limit any live consumer asked for, so a small one cannot truncate a big one", async () => {
    invoked.mockResolvedValue([]);
    renderHook(() => usePaneTokenUsage(8));
    renderHook(() => usePaneTokenUsage(256));
    await waitFor(() => expect(usageCalls()).toBeGreaterThan(0));
    const limits = invoked.mock.calls.filter(([cmd]) => cmd === "logs_usage").map(([, a]) => a);
    expect(limits.some((a) => (a as { limit: number }).limit === 256)).toBe(true);
  });

  it("stops polling when the last consumer unmounts — nothing polls with nobody listening", async () => {
    invoked.mockResolvedValue([]);
    const { unmount } = renderHook(() => usePaneTokenUsage(64));
    await waitFor(() => expect(usageCalls()).toBeGreaterThan(0));
    unmount();
    const after = usageCalls();
    await new Promise((r) => setTimeout(r, 60));
    expect(usageCalls()).toBe(after); // no further reads once nothing is mounted
  });
});

// BACK OFF WHILE THE ANSWER IS UNCHANGED (#pollers-back-off-when-a-pane-is-idle).
//
// `logs_usage` is the app's most expensive read — it re-parses every referenced Claude transcript on
// each call — and it was 655 calls / 324.8s in one session, much of it asking a quiet app the same
// question. These use fake timers so the schedule is asserted rather than waited on.
describe("usePaneTokenUsage — asks less often while nothing changes", () => {
  const usageCalls = () => invoked.mock.calls.filter(([cmd]) => cmd === "logs_usage").length;

  beforeEach(() => {
    invoked.mockReset();
    invoked.mockResolvedValue([]);
  });

  it("doubles the gap while the rollup is identical, and never past the cap", async () => {
    vi.useFakeTimers();
    try {
      const { unmount } = renderHook(() => usePaneTokenUsage(64));
      await vi.advanceTimersByTimeAsync(0);
      expect(usageCalls()).toBe(1); // the immediate lead read

      // Same answer every time ⇒ 4s, then 8s, then 16s. At the 4s mark only ONE more read has run.
      await vi.advanceTimersByTimeAsync(4000);
      expect(usageCalls()).toBe(2);
      await vi.advanceTimersByTimeAsync(4000);
      expect(usageCalls()).toBe(2); // backed off to 8s — the old code would have read here
      await vi.advanceTimersByTimeAsync(4000);
      expect(usageCalls()).toBe(3);

      // Far past the cap: bounded, so a change can never go unnoticed for longer than IDLE_INTERVAL_MS.
      const before = usageCalls();
      await vi.advanceTimersByTimeAsync(32000 * 3);
      const after = usageCalls() - before;
      expect(after).toBeGreaterThanOrEqual(3);
      expect(after).toBeLessThanOrEqual(4);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("snaps back to the working rate the moment the answer changes", async () => {
    vi.useFakeTimers();
    try {
      const { unmount } = renderHook(() => usePaneTokenUsage(64));
      await vi.advanceTimersByTimeAsync(0);
      // Sit quiet long enough to be well backed off.
      await vi.advanceTimersByTimeAsync(60000);
      const quiet = usageCalls();

      // A session starts working: the rollup changes, so the next tick must be at the FAST rate again.
      invoked.mockResolvedValue([{
        pane: "p1", session_id: "s", model: "claude", input_tokens: 1, output_tokens: 1,
        cache_creation_tokens: 0, cache_read_tokens: 0, cost_usd: 0.1,
      }]);
      await vi.advanceTimersByTimeAsync(32000); // the pending backed-off tick observes the change
      expect(usageCalls()).toBeGreaterThan(quiet);

      const afterChange = usageCalls();
      await vi.advanceTimersByTimeAsync(4000); // back at 4s
      expect(usageCalls()).toBe(afterChange + 1);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a fresh subscription starts at the working rate, never mid-back-off", async () => {
    vi.useFakeTimers();
    try {
      const first = renderHook(() => usePaneTokenUsage(64));
      await vi.advanceTimersByTimeAsync(60000); // back off hard
      first.unmount();

      invoked.mockClear();
      const second = renderHook(() => usePaneTokenUsage(64));
      await vi.advanceTimersByTimeAsync(0);
      expect(usageCalls()).toBe(1);
      await vi.advanceTimersByTimeAsync(4000);
      expect(usageCalls()).toBe(2); // 4s, not the 32s the previous subscription had crept to
      second.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
