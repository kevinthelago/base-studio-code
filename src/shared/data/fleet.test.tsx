import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Fleet } from "@/features/planner/fleet/Fleet";
import { useAppStore } from "@/store";
import {
  statusForPane, buildLiveWorkers, statusCounts, deriveFleetKpis,
} from "@/shared/lib/fleet/fleetLive";
import { emptyCoordState, type CoordState } from "@/shared/lib/fleet/coordination";
import type { AgentStream } from "@/features/planner/fleet/planFleet";

function stream(p: Partial<AgentStream> = {}): AgentStream {
  return { id: "s", name: "api", repo: "o/r", owns: [], issues: ["#1", "#2"], dependsOn: [], ...p };
}
function coord(p: Partial<CoordState> = {}): CoordState {
  return { ...emptyCoordState(), ...p };
}

describe("fleetLive mappers", () => {
  it("statusForPane: coordination wins over raw run/idle", () => {
    const ps = { t0p0: "run" as const };
    expect(statusForPane("t0p0", coord(), ps)).toBe("running");
    expect(statusForPane("t0p1", coord(), {})).toBe("idle");
    expect(statusForPane("t0p0", coord({ asking: [{ session: "t0p0", question: "q?", at: 0 }] }), ps)).toBe("asking");
    expect(statusForPane("t0p0", coord({ waiting: [{ session: "t0p0", reason: "r", at: 0 }] }), ps)).toBe("waiting");
    expect(statusForPane("t0p0", coord({ waiters: [{ session: "t0p0", deps: [{ kind: "issue", number: 9 }], registeredAt: 0 }] }), ps)).toBe("blocked");
    // Maintenance (#1957): idle + maintaining → maintenance; but active work (run) still wins.
    const maint = coord({ maintaining: [{ session: "t0p0", note: "standing by", at: 0 }] });
    expect(statusForPane("t0p0", maint, {})).toBe("maintenance");
    expect(statusForPane("t0p0", maint, ps)).toBe("running");
  });

  it("buildLiveWorkers: roster from launched fleet, drops closed/disabled panes (#1176 identity ids)", () => {
    // Fleet/triage panes key off IDENTITY ids (`<key>:<stream>`), recorded on the tab's `paneIds` —
    // NOT the legacy positional `t<idx>p<idx>`. The roster must resolve these (the empty-fleet bug
    // was the positional `tabOfPane` parse dropping every identity-keyed worker).
    const workers = buildLiveWorkers({
      fleetPaneStreams: {
        "proj:api": stream({ name: "api", profile: "pf_build", issues: ["#1", "#2", "#3"] }),
        "proj:docs": stream({ name: "docs", profile: "pf_docs" }),
        "ghost:x": stream({ name: "ghost" }),   // not on any open tab's paneIds → dropped
        "proj:off": stream({ name: "off" }),     // disabled → dropped
      },
      paneStatus: { "proj:api": "run", "proj:docs": "idle" },
      coord: coord({ waiting: [{ session: "proj:docs", reason: "awaiting review", at: 0 }] }),
      tabs: [{ paneIds: ["proj:api", "proj:docs", "proj:off"] }], // the live fleet tab
      disabledPanes: { "proj:off": true },
      profiles: [{ id: "pf_build", name: "Build & test" }, { id: "pf_docs", name: "Docs" }],
    });
    expect(workers.map(w => w.name)).toEqual(["api", "docs"]); // sorted by pane id, ghost + disabled dropped
    const api = workers.find(w => w.name === "api")!;
    expect(api.status).toBe("running");
    expect(api.profileLabel).toBe("Build & test");
    expect(api.issue).toBe("#1");
    expect(api.ownedTotal).toBe(3);
    const docs = workers.find(w => w.name === "docs")!;
    expect(docs.status).toBe("waiting");
    expect(docs.note).toBe("awaiting review");
  });

  it("statusCounts + deriveFleetKpis tally by status", () => {
    const workers = buildLiveWorkers({
      fleetPaneStreams: { "proj:a": stream({ name: "a" }), "proj:b": stream({ name: "b" }), "proj:c": stream({ name: "c" }) },
      paneStatus: { "proj:a": "run", "proj:b": "run", "proj:c": "idle" },
      coord: coord({ waiters: [{ session: "proj:c", deps: [{ kind: "issue", number: 1 }], registeredAt: 0 }] }),
      tabs: [{ paneIds: ["proj:a", "proj:b", "proj:c"] }], disabledPanes: {}, profiles: [],
    });
    expect(statusCounts(workers)).toEqual({ running: 2, blocked: 1 });
    expect(deriveFleetKpis(workers)).toEqual({ total: 3, active: 2, needAttention: 1, idle: 0 });
  });
});

describe("Fleet screen", () => {
  beforeEach(() => useAppStore.setState({ fleetPaneStreams: {}, paneStatus: {}, tabs: [], disabledPanes: {} }));

  it("shows the empty state when no fleet is running", () => {
    render(<Fleet />);
    expect(screen.getByText(/no fleet running/i)).toBeTruthy();
  });

  it("renders the live worker board when a fleet is launched", () => {
    // #1176: fleet panes key off IDENTITY ids (`<key>:<stream>`) recorded on the tab's `paneIds`;
    // buildLiveWorkers drops any worker not on an open tab's paneIds.
    useAppStore.setState({
      fleetPaneStreams: { "proj:api": stream({ name: "api", issues: ["#1"] }) },
      paneStatus: { "proj:api": "run" },
      tabs: [{ name: "proj · build", layout: "1×1", state: "run", paneIds: ["proj:api"] }] as never,
      disabledPanes: {},
      agentProfiles: [] as never,
    });
    render(<Fleet />);
    expect(screen.getByText("Worker board")).toBeTruthy();
    expect(screen.getByText("api")).toBeTruthy();
    expect(screen.getByText("active workers")).toBeTruthy();
  });

  it("opens a worker's per-agent page and returns via '← fleet' (#499)", () => {
    useAppStore.setState({
      fleetPaneStreams: { "proj:api": stream({ name: "api", issues: ["#1", "#2"], profile: "pf_build" }) },
      paneStatus: { "proj:api": "run" },
      paneProfiles: { "proj:api": "pf_build" } as never,
      paneFlows: {} as never,
      agentProfiles: [{
        id: "pf_build", name: "Build & test", color: "#fff", category: "generated", origin: "by planner",
        desc: "", mode: "ask", commands: [],
        tools: { read: "allow", grep: "allow", glob: "allow", edit: "allow", write: "allow", bash: "ask", web: "ask", task: "allow" },
        paths: { allow: ["src/**"], deny: ["**/.env"] }, net: { allow: ["crates.io"] }, builtin: false,
      }] as never,
      tabs: [{ name: "proj · build", layout: "1×1", state: "run", paneIds: ["proj:api"] }] as never,
      disabledPanes: {},
    });
    render(<Fleet />);
    // Click the worker row to drill in.
    fireEvent.click(screen.getByText("api"));
    expect(screen.getByRole("button", { name: "Back to fleet" })).toBeTruthy();
    expect(screen.getByText("Execution flow")).toBeTruthy();
    expect(screen.getByText("Owned issues")).toBeTruthy();
    // Permissions render from the real profile.
    expect(screen.getByText("Permissions")).toBeTruthy();
    // Back to the board.
    fireEvent.click(screen.getByRole("button", { name: "Back to fleet" }));
    expect(screen.getByText("Worker board")).toBeTruthy();
  });

  it("per-agent pause/resume + profile modal are wired to the store (#499)", () => {
    useAppStore.setState({
      fleetPaneStreams: { "proj:api": stream({ name: "api", issues: ["#1"], profile: "pf_build" }) },
      paneStatus: { "proj:api": "run" },
      paneProfiles: { "proj:api": "pf_build" } as never,
      paneFlows: {} as never,
      agentProfiles: [{
        id: "pf_build", name: "Build & test", color: "#fff", category: "generated", origin: "by planner",
        desc: "", mode: "ask", commands: [],
        tools: { read: "allow", grep: "allow", glob: "allow", edit: "allow", write: "allow", bash: "ask", web: "ask", task: "allow" },
        paths: { allow: ["src/**"], deny: ["**/.env"] }, net: { allow: ["crates.io"] }, builtin: false,
      }] as never,
      tabs: [{ name: "proj · build", layout: "1×1", state: "run", paneIds: ["proj:api"] }] as never,
      disabledPanes: {},
    });
    render(<Fleet />);
    fireEvent.click(screen.getByText("api"));
    // Pause disables the pane in the store.
    fireEvent.click(screen.getByText("⏸ pause"));
    expect(useAppStore.getState().disabledPanes["proj:api"]).toBe(true);
    // Profile modal lists the profiles.
    fireEvent.click(screen.getByText("⛉ profile"));
    expect(screen.getByText("Change profile")).toBeTruthy();
  });
});
