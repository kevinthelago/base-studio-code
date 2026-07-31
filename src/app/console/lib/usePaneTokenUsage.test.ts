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
import { usePaneTokenUsage } from "./usePaneTokenUsage";

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
