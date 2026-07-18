// resumePaneSession (#glance-resume) — resume ONE dormant fleet/agent pane in place, non-disruptively.
import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./";
import type { EndedInfo } from "./types";

const ended = (streamId = "api"): EndedInfo => ({ state: "done", streamId, summary: "2/2 complete", at: 1 });

// A build tab that owns the `proj:*` identity ids (findPaneOwnerTab matches on paneIds).
const buildTab = () => [{
  id: "t", name: "Proj · build", layout: "2×1", state: "idle", runId: 0, kind: "build",
  paneIds: ["proj:director", "proj:api"],
}] as never;

describe("resumePaneSession (#glance-resume)", () => {
  beforeEach(() => {
    useAppStore.setState({
      tabs: buildTab(),
      endedPanes: {}, disabledPanes: {}, dormantPanes: {}, restoreRequested: {},
      paneStatus: {}, paneLastActivity: {},
    });
  });

  it("clears the pane's ended/disabled/dormant flags and stamps restoreRequested (→ claude --continue)", () => {
    useAppStore.setState({ endedPanes: { "proj:api": ended() }, disabledPanes: { "proj:api": true } });
    const ok = useAppStore.getState().resumePaneSession("proj:api");
    expect(ok).toBe(true);
    const s = useAppStore.getState();
    expect(s.endedPanes["proj:api"]).toBeUndefined();
    expect(s.disabledPanes["proj:api"]).toBeUndefined();
    expect(s.restoreRequested["proj:api"]).toBe(true);
  });

  it("returns false and changes nothing when no open tab hosts the pane id (caller falls back)", () => {
    const before = useAppStore.getState().restoreRequested;
    const ok = useAppStore.getState().resumePaneSession("gone:worker");
    expect(ok).toBe(false);
    expect(useAppStore.getState().restoreRequested).toBe(before); // untouched
  });

  it("touches ONLY the target pane — a live sibling in the same tab is left running", () => {
    useAppStore.setState({ endedPanes: { "proj:api": ended() }, paneStatus: { "proj:director": "run" } });
    useAppStore.getState().resumePaneSession("proj:api");
    const s = useAppStore.getState();
    // The director keeps its live status and never gets a restore request — no whole-tab remount.
    expect(s.paneStatus["proj:director"]).toBe("run");
    expect(s.restoreRequested["proj:director"]).toBeUndefined();
  });
});
