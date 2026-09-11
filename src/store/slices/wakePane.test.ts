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

  // END SESSION vs PAUSE — the distinction the Glance End button got wrong.
  //
  // `killPane` used to set `disabledPanes`, the "the user turned this cell off" flag that `wakePane`
  // refuses outright. So ending a session was a one-way door: the director could see the worker and
  // never bring it back. It reaps instead now, and these two assert the pair — a wake revives what a
  // user CLOSED and still refuses what a user PAUSED.
  it("wakes a pane that End session closed (dormant), so ending is not permanent", () => {
    useAppStore.setState({ dormantPanes: { [PANE]: true }, disabledPanes: {} });
    expect(useAppStore.getState().wakePane(PANE, "pick it back up")).toBe(true);
    expect(useAppStore.getState().dormantPanes[PANE]).toBeUndefined();
    expect(useAppStore.getState().paneStartupPromptText[PANE]).toBe("pick it back up");
  });

  it("revives a pane that was DISABLED, and clears the flag", () => {
    // Maintainer's call (2026-08-26) after being blocked three times: "end session simply closes it
    // and doesn't prevent the director from re-starting it". The refusal's rationale — "the user
    // turned that cell off deliberately" — did not survive how the flag is actually reached: the
    // Glance End button set it, it persists across restarts, and only a Console pane-menu toggle
    // clears it, which a director cannot reach. A wake is one explicit, targeted act; if a pane
    // should stay off, do not wake it.
    useAppStore.setState({ disabledPanes: { [PANE]: true }, dormantPanes: {} });
    expect(useAppStore.getState().wakePane(PANE, "go")).toBe(true);
    expect(useAppStore.getState().disabledPanes[PANE]).toBeUndefined();
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

  // `a-woken-fleet-worker-has-no-mount-so-wake-spawns-nothing`: nothing keys on runId since the console went
  // one terminal per tab. The launch generation is what `TerminalHost` mounts and relaunches by.
  it("bumps the pane's launch generation on every wake, so the host mounts and relaunches it", () => {
    useAppStore.setState({ paneLaunchGen: {} });
    expect(useAppStore.getState().wakePane(PANE, "first")).toBe(true);
    expect(useAppStore.getState().paneLaunchGen[PANE]).toBe(1);
    expect(useAppStore.getState().wakePane(PANE, "second")).toBe(true);
    expect(useAppStore.getState().paneLaunchGen[PANE]).toBe(2);
  });

  it("returns false for a pane no open tab hosts, so the caller can fall back", () => {
    expect(useAppStore.getState().wakePane("other-project:ghost", "x")).toBe(false);
  });

  it("revives a DISABLED pane rather than refusing it", () => {
    // The original rationale — "the user turned that cell off deliberately" — is superseded
    // (maintainer, 2026-08-26). It made `disabledPanes` a permanent state no director could leave:
    // the Glance End button set it, it survives restarts, and only a Console pane-menu toggle clears
    // it. A wake is one explicit, targeted act; if a pane should stay off, do not wake it.
    useAppStore.setState({ disabledPanes: { [PANE]: true } });
    expect(useAppStore.getState().wakePane(PANE, "x")).toBe(true);
    expect(useAppStore.getState().disabledPanes[PANE]).toBeUndefined();
  });
});
