// #4101 — the wake decision. The verdict matters more than the happy path: `wakePane` kills the PTY
// before relaunching, so a false reported as success leaves a dead worker (#4025).
import { describe, it, expect, vi } from "vitest";
import { applyWake, DEFAULT_WAKE_PROMPT } from "./fleetWakeBridge";

describe("applyWake", () => {
  it("wakes the pane and reports the verdict", () => {
    const wakePane = vi.fn().mockReturnValue(true);
    expect(applyWake("r1", { paneId: "proj:api", prompt: "rebase onto develop" }, { wakePane })).toEqual({
      id: "r1",
      woke: true,
    });
    expect(wakePane).toHaveBeenCalledWith("proj:api", "rebase onto develop");
  });

  it("supplies the standard wake prompt when the caller gives none", () => {
    const wakePane = vi.fn().mockReturnValue(true);
    applyWake("r2", { paneId: "proj:api" }, { wakePane });
    expect(wakePane).toHaveBeenCalledWith("proj:api", DEFAULT_WAKE_PROMPT);
    // A whitespace-only prompt is the same as none — otherwise the worker wakes to a blank task.
    applyWake("r3", { paneId: "proj:api", prompt: "   " }, { wakePane });
    expect(wakePane).toHaveBeenLastCalledWith("proj:api", DEFAULT_WAKE_PROMPT);
  });

  it("carries a FALSE verdict through instead of reporting success", () => {
    // The #4025 shape: wakePane cannot resolve the pane, so nothing was woken — but the kill already
    // happened. Reporting `woke: true` here is what made that bug silent.
    const ack = applyWake("r4", { paneId: "ghost" }, { wakePane: () => false });
    expect(ack.woke).toBe(false);
  });

  it("rejects an empty pane id without touching the store", () => {
    const wakePane = vi.fn().mockReturnValue(true);
    const ack = applyWake("r5", { paneId: "  " }, { wakePane });
    expect(ack.woke).toBe(false);
    expect(ack.error).toMatch(/no pane id/);
    expect(wakePane).not.toHaveBeenCalled();
  });
});
