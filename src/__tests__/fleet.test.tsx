import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Fleet } from "../screens/projects/Fleet";
import { useAppStore } from "../store";
import {
  statusForPane, buildLiveWorkers, statusCounts, deriveFleetKpis, tabOfPane,
} from "../lib/fleetLive";
import { emptyCoordState, type CoordState } from "../lib/coordination";
import type { AgentStream } from "../screens/projects/planSections";

function stream(p: Partial<AgentStream> = {}): AgentStream {
  return { id: "s", name: "api", repo: "o/r", owns: [], issues: ["#1", "#2"], dependsOn: [], ...p };
}
function coord(p: Partial<CoordState> = {}): CoordState {
  return { ...emptyCoordState(), ...p };
}

describe("fleetLive mappers", () => {
  it("tabOfPane parses the tab index", () => {
    expect(tabOfPane("t2p0")).toBe(2);
    expect(tabOfPane("nope")).toBe(-1);
  });

  it("statusForPane: coordination wins over raw run/idle", () => {
    const ps = { t0p0: "run" as const };
    expect(statusForPane("t0p0", coord(), ps)).toBe("running");
    expect(statusForPane("t0p1", coord(), {})).toBe("idle");
    expect(statusForPane("t0p0", coord({ asking: [{ session: "t0p0", question: "q?", at: 0 }] }), ps)).toBe("asking");
    expect(statusForPane("t0p0", coord({ waiting: [{ session: "t0p0", reason: "r", at: 0 }] }), ps)).toBe("waiting");
    expect(statusForPane("t0p0", coord({ waiters: [{ session: "t0p0", deps: [{ kind: "issue", number: 9 }], registeredAt: 0 }] }), ps)).toBe("blocked");
  });

  it("buildLiveWorkers: roster from launched fleet, drops closed/disabled panes", () => {
    const workers = buildLiveWorkers({
      fleetPaneStreams: {
        t0p0: stream({ name: "api", profile: "pf_build", issues: ["#1", "#2", "#3"] }),
        t0p1: stream({ name: "docs", profile: "pf_docs" }),
        t9p0: stream({ name: "ghost" }),       // tab 9 doesn't exist → dropped
        t0p2: stream({ name: "off" }),          // disabled → dropped
      },
      paneStatus: { t0p0: "run", t0p1: "idle" },
      coord: coord({ waiting: [{ session: "t0p1", reason: "awaiting review", at: 0 }] }),
      tabCount: 1,
      disabledPanes: { t0p2: true },
      profiles: [{ id: "pf_build", name: "Build & test" }, { id: "pf_docs", name: "Docs" }],
    });
    expect(workers.map(w => w.name)).toEqual(["api", "docs"]); // sorted by pane id, ghosts dropped
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
      fleetPaneStreams: { t0p0: stream({ name: "a" }), t0p1: stream({ name: "b" }), t0p2: stream({ name: "c" }) },
      paneStatus: { t0p0: "run", t0p1: "run", t0p2: "idle" },
      coord: coord({ waiters: [{ session: "t0p2", deps: [{ kind: "issue", number: 1 }], registeredAt: 0 }] }),
      tabCount: 1, disabledPanes: {}, profiles: [],
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
    useAppStore.setState({
      fleetPaneStreams: { t0p0: stream({ name: "api", issues: ["#1"] }) },
      paneStatus: { t0p0: "run" },
      tabs: [{ name: "proj · build", layout: "1×1", state: "run" }] as never,
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
      fleetPaneStreams: { t0p0: stream({ name: "api", issues: ["#1", "#2"], profile: "pf_build" }) },
      paneStatus: { t0p0: "run" },
      paneProfiles: { t0p0: "pf_build" } as never,
      paneFlows: {} as never,
      agentProfiles: [{
        id: "pf_build", name: "Build & test", color: "#fff", category: "generated", origin: "by planner",
        desc: "", mode: "ask", commands: [],
        tools: { read: "allow", grep: "allow", glob: "allow", edit: "allow", write: "allow", bash: "ask", web: "ask", task: "allow" },
        paths: { allow: ["src/**"], deny: ["**/.env"] }, net: { allow: ["crates.io"] }, builtin: false,
      }] as never,
      tabs: [{ name: "proj · build", layout: "1×1", state: "run" }] as never,
      disabledPanes: {},
    });
    render(<Fleet />);
    // Click the worker row to drill in.
    fireEvent.click(screen.getByText("api"));
    expect(screen.getByText("← fleet")).toBeTruthy();
    expect(screen.getByText("Execution flow")).toBeTruthy();
    expect(screen.getByText("Owned issues")).toBeTruthy();
    // Permissions render from the real profile.
    expect(screen.getByText("Permissions")).toBeTruthy();
    // Back to the board.
    fireEvent.click(screen.getByText("← fleet"));
    expect(screen.getByText("Worker board")).toBeTruthy();
  });
});
