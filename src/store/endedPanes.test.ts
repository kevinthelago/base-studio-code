import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { useAppStore } from "./";
import type { EndedInfo } from "./types";

const done = (streamId = "api"): EndedInfo => ({ state: "done", streamId, summary: "2/2 complete", at: 1 });

describe("endedPanes — auto-end a finished worker (#920)", () => {
  beforeEach(() => {
    useAppStore.setState({ endedPanes: {}, paneStatus: {}, paneWasClaude: {}, disabledPanes: {}, restoreRequested: {} });
  });

  it("markPaneEnded records the resting state and drops the pane's live status", () => {
    useAppStore.setState({ paneStatus: { t0p1: "run" } });
    useAppStore.getState().markPaneEnded("t0p1", done());
    expect(useAppStore.getState().endedPanes["t0p1"]).toMatchObject({ state: "done", streamId: "api" });
    expect(useAppStore.getState().paneStatus["t0p1"]).toBeUndefined();
  });

  it("never re-marks an already-ended pane", () => {
    useAppStore.getState().markPaneEnded("t0p1", done("api"));
    const before = useAppStore.getState().endedPanes;
    useAppStore.getState().markPaneEnded("t0p1", { ...done("other"), state: "blocked" });
    expect(useAppStore.getState().endedPanes).toBe(before); // same ref — no churn, keeps first verdict
    expect(useAppStore.getState().endedPanes["t0p1"].streamId).toBe("api");
  });

  it("reopenPane clears the ended state so the worker can relaunch", () => {
    useAppStore.getState().markPaneEnded("t0p1", done());
    useAppStore.getState().reopenPane("t0p1");
    expect(useAppStore.getState().endedPanes["t0p1"]).toBeUndefined();
  });

  describe("crash recovery never re-opens an ended worker", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("restoreSessionsFromCrash skips a pane in the ended state", () => {
      useAppStore.setState({
        tabs: [{ id: "t", name: "build", layout: "2×1", state: "idle", runId: 0 }] as never,
        paneWasClaude: { t0p0: true, t0p1: true },
        endedPanes: { t0p1: done() },
        restoreRequested: {},
      });

      const count = useAppStore.getState().restoreSessionsFromCrash();
      expect(count).toBe(2); // both were claude panes…
      vi.advanceTimersByTime(1000); // …but the staggered relaunch runs the gate

      const restore = useAppStore.getState().restoreRequested;
      expect(restore["t0p0"]).toBe(true);       // live worker → relaunched
      expect(restore["t0p1"]).toBeUndefined();  // ended worker → NOT relaunched
    });
  });
});
