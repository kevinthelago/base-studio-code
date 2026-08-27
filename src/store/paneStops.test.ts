import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAppStore } from "./";
import { STOP_NOTICE_MS } from "@/app/console/lib/paneStops";

vi.mock("@/shared/lib/core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const { log } = await import("@/shared/lib/core/log");

/**
 * #a-stopped-session-says-why — the STORE half.
 *
 * The reason for an app-side stop is the ACTION that ran, so each stop action reports itself. That
 * placement is the point: it is why a new caller of `reapPane` cannot forget to say why, and it is
 * what this file pins.
 */
describe("a stopped pane reports itself (#a-stopped-session-says-why)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({
      paneStops: [], dormantPanes: {}, endedPanes: {}, quarantinedPanes: {}, disabledPanes: {},
      paneStatus: {}, tabs: [],
    });
  });

  const stops = () => useAppStore.getState().paneStops;

  it("the IDLE REAPER says the pane was reclaimed, and says it resumes", () => {
    useAppStore.getState().reapPane("proj:worker");
    expect(stops()).toHaveLength(1);
    expect(stops()[0].reason).toBe("reaped");
    expect(stops()[0].detail).toMatch(/idle/i);
  });

  it("WORKER AUTO-END carries the completeness summary the user would otherwise have to go find", () => {
    useAppStore.getState().markPaneEnded("proj:worker", {
      state: "needs-attention", streamId: "worker", summary: "stopped early — 1/1 still open", at: 1,
    });
    expect(stops()[0].reason).toBe("auto-ended");
    expect(stops()[0].detail).toBe("stopped early — 1/1 still open");
  });

  it("a WARDEN QUARANTINE reports the warden's own summary", () => {
    useAppStore.getState().markQuarantine("proj:worker", { summary: "wrote outside its lane" } as never);
    expect(stops()[0].reason).toBe("quarantined");
    expect(stops()[0].detail).toBe("wrote outside its lane");
  });

  it("DISABLING a pane is a stop; RE-ENABLING it is not an event", () => {
    useAppStore.getState().setPaneDisabled("proj:worker", true);
    expect(stops()).toHaveLength(1);
    expect(stops()[0].reason).toBe("disabled");
    useAppStore.getState().setPaneDisabled("proj:worker", false);
    // Turning it back on is not a stop — reporting it would make the banner fire on a recovery.
    expect(stops()).toHaveLength(1);
  });

  it("never re-reports a stop the action itself refuses to repeat", () => {
    // Each action guards against re-marking; the report sits INSIDE that guard, so a second call is
    // silent rather than a duplicate banner.
    useAppStore.getState().reapPane("proj:worker");
    useAppStore.getState().reapPane("proj:worker");
    expect(stops()).toHaveLength(1);
    useAppStore.getState().markPaneEnded("proj:a", { state: "done", streamId: "a", summary: "done", at: 1 });
    useAppStore.getState().markPaneEnded("proj:a", { state: "done", streamId: "a", summary: "again", at: 2 });
    expect(stops().filter((s) => s.paneId === "proj:a")).toHaveLength(1);
  });

  /// The banner lasts five seconds; THIS is what answers the question afterwards, so it is written
  /// unconditionally — and the level is what makes `grep WARN` a list of sessions that DIED.
  it("LOGS every stop, faults at warn and routine ones at info", () => {
    useAppStore.getState().notePaneStopped("proj:w", "failed", "exited 1");
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.warn).mock.calls[0][0]).toContain("proj:w");
    expect(vi.mocked(log.warn).mock.calls[0][0]).toContain("exited 1");
    // (message, scope) — the swap is invisible to tsc because both are strings.
    expect(vi.mocked(log.warn).mock.calls[0][1]).toBe("session");

    useAppStore.getState().notePaneStopped("proj:x", "finished", "exited 0");
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("keeps only the NEWEST stop per pane — the reported worker stopped nine times in one run", () => {
    useAppStore.getState().notePaneStopped("proj:w", "failed", "first");
    useAppStore.getState().notePaneStopped("proj:w", "signalled", "second");
    expect(stops()).toHaveLength(1);
    expect(stops()[0].detail).toBe("second");
  });

  it("is TRANSIENT — the ledger is not in the persisted snapshot", async () => {
    // A notice that survives a restart is a notice about a session the user is no longer looking at.
    const { persistedState } = await import("@/store/persist");
    useAppStore.getState().notePaneStopped("proj:w", "failed", "boom");
    expect(persistedState(useAppStore.getState() as never)).not.toHaveProperty("paneStops");
  });

  it("stamps `at` so the notice can expire on its own", () => {
    const before = Date.now();
    useAppStore.getState().notePaneStopped("proj:w", "failed", "boom");
    const { at } = stops()[0];
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
    expect(STOP_NOTICE_MS).toBe(5_000);
  });
});
