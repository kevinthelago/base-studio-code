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

// ── STARTING a stream that never launched (#the-director-cannot-start-a-stream-that-never-launched) ──
//
// Reported from a running fleet: "the director is unable to start sessions that aren't already opened."
//
// The refusal above (`REFUSES a stream that is not in the project's fleet`) used `fleetPaneStreams` as
// the oracle for "is this a real stream". But that map is written by `fleetStartProject` alone, so it is
// the roster of what LAUNCHED — never of what the plan HOLDS. A stream plan.db names and no session ever
// ran has no entry, so it read as UNKNOWN and the wake refused. `bsc fleet list` calls that state
// `never-launched` and sent the director to `bsc fleet start <projectKey>`, a WHOLE-fleet launch that is
// refused outright while any pane is live — so a director with a running fleet had no lever at all.
//
// Rust reads plan.db (`fleet/start.rs` already does) and now carries the row, with the absolute cwd it
// resolved, on `bsc://fleet-wake` for a pane that is NOT LIVE. So the store's answer to "is this real"
// comes from the plan rather than from its own launch history, and the acceptance's line survives
// intact: Rust resolving NOTHING means plan.db does not name it, and that still refuses.
import type { AgentStream } from "@/features/planner/fleet/planFleet";

/** The plan row for a stream that has never launched, as Rust hands it over. */
const NEVER_LAUNCHED: AgentStream & { cwd: string } = {
  id: STREAM, name: "API", repo: "own/api", owns: ["src/api/"], issues: ["#7"], dependsOn: [],
  cwd: "/home/u/.base-studio-code/worktrees/demo/api--api",
};

describe("wakePane STARTS a stream the roster never saw", () => {
  beforeEach(() => { resetFleetPanes(); useAppStore.setState({ tabs: [] }); });

  /** A build tab exists (the director is running in it) and the roster is EMPTY — the never-launched case. */
  function armUnlaunched() {
    useAppStore.setState({
      tabs: [buildTab([`${KEY}:director`])],
      fleetPaneStreams: {}, disabledPanes: {}, dormantPanes: {}, endedPanes: {},
      personas: [], blueprints: [], projectBlueprintId: {},
    } as never);
  }

  it("seats the pane when Rust supplies the plan row", () => {
    armUnlaunched();
    expect(useAppStore.getState().wakePane(PANE, "start on #7", NEVER_LAUNCHED)).toBe(true);
    expect(useAppStore.getState().tabs[0].paneIds).toContain(PANE);
  });

  it("adopts the row into the roster, so the NEXT wake needs no plan lookup", () => {
    // The roster is what `bsc fleet wake` reads on the second call, and what the coordinator resolves a
    // pane's stream through — a pane seated without it would be a session nothing could attribute.
    armUnlaunched();
    useAppStore.getState().wakePane(PANE, "go", NEVER_LAUNCHED);
    expect(useAppStore.getState().fleetPaneStreams[PANE]?.id).toBe(STREAM);
    // `cwd` is a LAUNCH fact, not part of the plan row — it must not be stored as if it were.
    expect(useAppStore.getState().fleetPaneStreams[PANE]).not.toHaveProperty("cwd");
  });

  it("uses the absolute cwd RUST resolved, never a re-derived one", () => {
    // #905: re-deriving it here reads the async-loaded `bscBaseDir` mirror, and an empty one drops the
    // session at the user's home dir. `bscBaseDir` is deliberately left unset to prove nothing falls back.
    armUnlaunched();
    useAppStore.setState({ bscBaseDir: "" } as never);
    useAppStore.getState().wakePane(PANE, "go", NEVER_LAUNCHED);
    expect(useAppStore.getState().paneCwds[PANE]).toBe(NEVER_LAUNCHED.cwd);
  });

  it("still REFUSES when Rust resolved nothing — an unknown stream stays an error", () => {
    // This is the whole reason the refusal moved rather than being deleted: plan.db not naming the
    // stream is what "unknown" now means, and it arrives as an absent `stream`.
    armUnlaunched();
    expect(useAppStore.getState().wakePane(fleetPaneId(KEY, "not-a-stream"), "go")).toBe(false);
    expect(useAppStore.getState().tabs[0].paneIds).not.toContain(fleetPaneId(KEY, "not-a-stream"));
  });

  it("wires the woken pane EXACTLY as a launch would have wired it", () => {
    // The anti-drift guard, and the reason `streamPaneWiring` exists. Two launch paths that agree today
    // and diverge later is the failure this codebase has paid for before (`fleetStartBridge`'s header
    // names it). So: launch the same row, record what it produced, then wake it and compare.
    const streamRow: AgentStream = (({ cwd: _cwd, ...row }) => row)(NEVER_LAUNCHED);
    resetFleetPanes();
    useAppStore.setState({ tabs: [], personas: [], blueprints: [], projectBlueprintId: {}, bscBaseDir: "/base" } as never);
    useAppStore.getState().fleetStartProject("Demo", { recommended: 1, reasoning: "t", streams: [streamRow], director: { enabled: false } }, KEY,
      { hubPath: "/hub", worktreePaths: { [STREAM]: NEVER_LAUNCHED.cwd } });
    const launched = useAppStore.getState();
    const asLaunched = {
      role: launched.paneRoles[PANE], profile: launched.paneProfiles[PANE], repo: launched.paneRepos[PANE],
      globs: launched.paneRoleGlobs[PANE], flow: launched.paneFlows[PANE], model: launched.paneModels[PANE],
      stream: launched.paneStream[PANE], cwd: launched.paneCwds[PANE],
    };

    resetFleetPanes();
    armUnlaunched();
    useAppStore.getState().wakePane(PANE, "go", NEVER_LAUNCHED);
    const woken = useAppStore.getState();
    expect({
      role: woken.paneRoles[PANE], profile: woken.paneProfiles[PANE], repo: woken.paneRepos[PANE],
      globs: woken.paneRoleGlobs[PANE], flow: woken.paneFlows[PANE], model: woken.paneModels[PANE],
      stream: woken.paneStream[PANE], cwd: woken.paneCwds[PANE],
    }).toEqual(asLaunched);
    // Non-vacuity: the comparison is worthless if the launch wired nothing.
    expect(asLaunched.role).toBe("worker");
    expect(asLaunched.globs, "the owned path became a write boundary").toEqual(["src/api/**"]);
  });

  it("leaves the ALREADY-ROSTERED path alone — a plain wake still needs no stream", () => {
    arm([]);
    expect(useAppStore.getState().wakePane(PANE, "resume")).toBe(true);
    expect(useAppStore.getState().tabs[0].paneIds).toContain(PANE);
  });
});
