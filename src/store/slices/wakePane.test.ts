import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "@/store";

/**
 * #4025 — `wakePane` used to resolve its tab by parsing `^t(\d+)p\d+$` out of the pane id: the
 * POSITIONAL scheme that pane identity replaced. Measured on the live coord log, 0 of 273 sessions
 * were positional. So it returned false for every real pane — and since `actuateWake` kills the PTY
 * BEFORE calling it, the Coordination inbox's Wake button killed a parked worker and never brought it
 * back, skipping the `woke` event so the log did not even record it.
 */
describe("wakePane resolves a pane by IDENTITY (#4025)", () => {
  const PANE = "studio-code:director";

  beforeEach(() => {
    useAppStore.setState({
      tabs: [{ name: "build", state: "idle", paneIds: [PANE], runId: 0 } as never],
      disabledPanes: {}, dormantPanes: {}, endedPanes: {},
      paneStartupPromptText: {}, paneContinue: {},
    });
  });

  it("wakes a pane whose id is an identity id, not tNpM", () => {
    expect(useAppStore.getState().wakePane(PANE, "do the thing")).toBe(true);
    const s = useAppStore.getState();
    expect(s.paneStartupPromptText[PANE]).toBe("do the thing");
    // A WAKE RESUMES. This asserted `false`, reasoning that "`actuateWake` has already killed the PTY,
    // so a resumed conversation is not what comes back" — which conflates the PROCESS with the
    // CONVERSATION. Killing the shell ends the process; `--continue` resumes from a transcript on
    // disk, which the kill does not touch. Observed directly: a caged worker whose PTY died eight
    // times still had its transcripts, and once the launch looked in the right place a later launch
    // appended to the existing conversation rather than opening a fifth one.
    //
    // So the kill and the resume are not in tension — killing the shell and continuing the
    // conversation is exactly the combination a wake wants. `plan_launch` computes
    // `resume: continue_session && has_history`, so with nothing to continue this still starts fresh
    // and still delivers the baked prompt.
    expect(s.paneContinue[PANE]).toBe(true);
    expect(s.tabs[0].runId).toBe(1); // the remount lever
  });

  it("clears dormant so a REAPED pane comes back as a terminal, not the placeholder", () => {
    // Without this the runId bump remounts the DormantConsole card, no PTY is created, and the baked
    // prompt never runs — the assignment would vanish exactly for the panes reaping targets.
    useAppStore.setState({
      dormantPanes: { [PANE]: true },
      endedPanes: { [PANE]: { state: "done", streamId: "director", summary: "3/3 complete", at: 1 } },
    });
    expect(useAppStore.getState().wakePane(PANE, "go")).toBe(true);
    expect(useAppStore.getState().dormantPanes[PANE]).toBeUndefined();
    expect(useAppStore.getState().endedPanes[PANE]).toBeUndefined();
  });

  it("returns false for a pane no open tab hosts, so the caller can fall back", () => {
    expect(useAppStore.getState().wakePane("other-project:ghost", "x")).toBe(false);
  });

  it("refuses a DISABLED pane — the user turned that cell off deliberately", () => {
    useAppStore.setState({ disabledPanes: { [PANE]: true } });
    expect(useAppStore.getState().wakePane(PANE, "x")).toBe(false);
  });
});
