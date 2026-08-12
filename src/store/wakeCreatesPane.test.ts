// #fleet-wake-reaches-a-session-with-no-pane — the director's one lever over a stopped stream.
//
// Reported from a running fleet: "the director is unable to wake sessions that aren't running."
// `wakePane` resolved the owning tab and bailed when there was none, so it could only ever wake a pane
// that ALREADY EXISTED in an open tab — which is the opposite of the case the director protocol names
// it for ("a stream still has open issues but its session is not live").
//
// It matters more now than when it was filed: under the no-app-injection directive the app never starts
// or prompts a session, so a stream that has stopped has exactly ONE way back that is not a user click,
// and this is it.
//
// NOTE the adjacent fix this is NOT: #4025 made wake resolve the owning tab by IDENTITY rather than by
// the retired positional id, which fixed wake for panes that exist. This is the pane that does not.
import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./";
import { resetFleetPanes } from "@/test/storeReset";
import { fleetPaneId } from "@/app/console/lib/paneIdentity";

const KEY = "demo";
const STREAM = "api";
const PANE = fleetPaneId(KEY, STREAM);

/** A build tab for `demo` that does NOT contain the api pane — a closed-and-reopened fleet, or a
 *  stream that was planned but never launched. */
function buildTab(paneIds: string[]) {
  return {
    id: "tab-1", name: "Demo · build", layout: "2×2", state: "idle",
    runId: 1, projectKey: KEY, kind: "build" as const, seq: 0, paneIds,
  };
}

/** Arm the store as a real fleet leaves it: the roster knows the stream, the tab does not hold it. */
function arm(paneIds: string[], over: Record<string, unknown> = {}) {
  useAppStore.setState({
    tabs: [buildTab(paneIds)],
    fleetPaneStreams: { [PANE]: { id: STREAM, name: "API", repo: "own/api", owns: [], issues: [], dependsOn: [] } },
    disabledPanes: {},
    dormantPanes: {},
    endedPanes: {},
    ...over,
  } as never);
}

describe("wakePane reaches a stream whose pane does not exist", () => {
  beforeEach(() => { resetFleetPanes(); useAppStore.setState({ tabs: [] }); });

  it("creates the pane in the project's build tab and reports success", () => {
    // The regression: an empty `paneIds` used to make `findPaneOwnerTab` return null and wake return
    // false, which the Rust side surfaces as "it resolved to no open tab, or is disabled".
    arm([]);
    const ok = useAppStore.getState().wakePane(PANE, "pick up your open issues");
    expect(ok, "wake must succeed for a planned stream with no pane").toBe(true);
    expect(useAppStore.getState().tabs[0].paneIds).toContain(PANE);
  });

  it("bumps the owning tab's runId, so the new pane actually mounts", () => {
    // Seating the pane without the remount would leave the grid rendering yesterday's cells.
    arm([]);
    useAppStore.getState().wakePane(PANE, "go");
    expect(useAppStore.getState().tabs[0].runId).toBe(2);
  });

  it("bakes the prompt and clears --continue, exactly as an existing-pane wake does", () => {
    arm([]);
    useAppStore.getState().wakePane(PANE, "pick up #12");
    const st = useAppStore.getState();
    expect(st.paneStartupPromptText[PANE]).toBe("pick up #12");
    expect(st.paneContinue[PANE]).toBe(false);
  });

  it("fills a FREE cell before extending the grid", () => {
    // A reaped fleet leaves holes. Appending past them would grow the layout for no reason and leave
    // an empty cell in the middle of the grid.
    arm(["demo:director", "", "demo:web"]);
    useAppStore.getState().wakePane(PANE, "go");
    expect(useAppStore.getState().tabs[0].paneIds).toEqual(["demo:director", PANE, "demo:web"]);
  });

  it("REFUSES a stream that is not in the project's fleet — an unknown stream is a real error", () => {
    // The acceptance draws this line deliberately: an UNLAUNCHED stream is not an error, an UNKNOWN one
    // is. `fleetPaneStreams` is the roster, so its absence is what distinguishes them.
    arm([]);
    expect(useAppStore.getState().wakePane(fleetPaneId(KEY, "not-a-stream"), "go")).toBe(false);
    expect(useAppStore.getState().tabs[0].paneIds).toEqual([]);
  });

  it("REFUSES when the project has no build tab at all — that is a relaunch, not a wake", () => {
    useAppStore.setState({
      tabs: [],
      fleetPaneStreams: { [PANE]: { id: STREAM, name: "API", repo: "own/api", owns: [], issues: [], dependsOn: [] } },
    } as never);
    expect(useAppStore.getState().wakePane(PANE, "go")).toBe(false);
  });

  it("still refuses a DISABLED pane, and does not seat one behind the refusal", () => {
    arm([], { disabledPanes: { [PANE]: true } });
    expect(useAppStore.getState().wakePane(PANE, "go")).toBe(false);
    expect(useAppStore.getState().tabs[0].paneIds).toEqual([]);
  });

  it("leaves the EXISTING-pane path exactly as it was (#4025 must not regress)", () => {
    arm([PANE], { dormantPanes: { [PANE]: true }, endedPanes: { [PANE]: true } });
    const before = useAppStore.getState().tabs[0].paneIds;
    expect(useAppStore.getState().wakePane(PANE, "resume")).toBe(true);
    const st = useAppStore.getState();
    expect(st.tabs[0].paneIds).toEqual(before);          // not re-seated, not duplicated
    expect(st.dormantPanes[PANE]).toBeUndefined();        // the reaped placeholder is cleared…
    expect(st.endedPanes[PANE]).toBeUndefined();          // …and so is the ended mark
    expect(st.tabs[0].runId).toBe(2);
  });
});
