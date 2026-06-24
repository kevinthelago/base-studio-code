import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useAppStore } from "./";
import { directorPaneId, fleetPaneId, triagePaneId, manualPaneId } from "../lib/console/paneIdentity";

// Stage 3 of stable pane identity (#1176): crash recovery walks identity ids, not grid
// positions. It locates a pane's owning tab via `tab.paneIds`, skips manual consoles
// (`man:…`, which must never silently resume), and still understands legacy positional ids.

describe("restoreSessionsFromCrash — identity-aware recovery (#1176)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("recovers fleet/triage panes by their identity id and bumps the owning tab", () => {
    const dir = directorPaneId("proj"), worker = fleetPaneId("proj", "auth"), tri = triagePaneId("proj", "o/web");
    useAppStore.setState({
      tabs: [
        { id: "b", name: "build", layout: "2×1", state: "idle", runId: 0, kind: "build", paneIds: [dir, worker] },
        { id: "t", name: "triage", layout: "1×1", state: "idle", runId: 0, kind: "triage", paneIds: [tri] },
      ] as never,
      paneWasClaude: { [dir]: true, [worker]: true, [tri]: true },
      restoreRequested: {},
      disabledPanes: {},
      endedPanes: {},
    });

    const count = useAppStore.getState().restoreSessionsFromCrash();
    expect(count).toBe(3); // all three identity panes are recoverable
    vi.advanceTimersByTime(1000);

    const st = useAppStore.getState();
    expect(st.restoreRequested[dir]).toBe(true);
    expect(st.restoreRequested[worker]).toBe(true);
    expect(st.restoreRequested[tri]).toBe(true);
    // The build tab hosts two recovered panes → its runId is bumped once per pane; the triage tab once.
    expect(st.tabs[0].runId).toBe(2);
    expect(st.tabs[1].runId).toBe(1);
  });

  it("never auto-recovers a manual console (man:…) even if it ran claude", () => {
    const worker = fleetPaneId("proj", "auth");
    const manual = manualPaneId("scratch-tab", 0);
    useAppStore.setState({
      tabs: [
        { id: "b", name: "build", layout: "1×1", state: "idle", runId: 0, kind: "build", paneIds: [worker] },
        { id: "scratch-tab", name: "console", layout: "1×1", state: "idle", runId: 0 }, // manual tab (no kind)
      ] as never,
      paneWasClaude: { [worker]: true, [manual]: true },
      restoreRequested: {},
      disabledPanes: {},
      endedPanes: {},
    });

    const count = useAppStore.getState().restoreSessionsFromCrash();
    expect(count).toBe(1); // only the fleet worker — the manual pane is excluded
    vi.advanceTimersByTime(1000);

    const st = useAppStore.getState();
    expect(st.restoreRequested[worker]).toBe(true);
    expect(st.restoreRequested[manual]).toBeUndefined(); // scratch shell never silently resumes
    expect(st.tabs[1].runId).toBe(0);                    // manual tab untouched
  });
});
