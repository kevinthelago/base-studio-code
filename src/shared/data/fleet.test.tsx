import { describe, it, expect } from "vitest";
import {
  statusForPane, buildLiveWorkers, statusCounts, deriveFleetKpis,
} from "@/shared/lib/fleet/fleetLive";
import { STATUS } from "@/shared/data/fleet";
import { emptyCoordState, type CoordState } from "@/shared/lib/fleet/coordination";
import type { AgentStream } from "@/features/planner/fleet/planFleet";

function stream(p: Partial<AgentStream> = {}): AgentStream {
  return { id: "s", name: "api", repo: "o/r", owns: [], issues: ["#1", "#2"], dependsOn: [], ...p };
}
function coord(p: Partial<CoordState> = {}): CoordState {
  return { ...emptyCoordState(), ...p };
}

describe("STATUS display map", () => {
  it("maps every worker status to a label + color, incl. the calm maintenance treatment (#1957)", () => {
    // The board/donut/per-agent header all read STATUS[status] for the badge label + color and
    // the `.wd.<status>` dot class. A parked worker must have its own calm entry (not fall through).
    for (const s of ["running", "asking", "blocked", "waiting", "idle", "maintenance", "done"] as const) {
      expect(STATUS[s].label).toBeTruthy();
      expect(STATUS[s].color).toBeTruthy();
    }
    // Maintenance reads as a distinct "maintenance" badge in a calm teal — deliberately not an
    // alarming danger/accent tone (a finished worker parked & ready, not a problem).
    expect(STATUS.maintenance.label).toBe("maintenance");
    expect(STATUS.maintenance.color).toBe("oklch(0.75 0.10 195)");
    expect(STATUS.maintenance.color).not.toBe(STATUS.blocked.color);
    expect(STATUS.maintenance.color).not.toBe(STATUS.running.color);
  });
});

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
    expect(deriveFleetKpis(workers)).toEqual({ total: 3, active: 2, needAttention: 1, idle: 0, maintenance: 0 });
  });

  it("deriveFleetKpis surfaces a parked (maintenance) worker (#1957)", () => {
    // A finished worker parked in maintenance is neither running, need-attention, nor idle —
    // it must land in its own `maintenance` (parked & ready) count so it isn't invisible.
    const workers = buildLiveWorkers({
      fleetPaneStreams: { "proj:a": stream({ name: "a" }), "proj:b": stream({ name: "b" }) },
      paneStatus: { "proj:a": "run", "proj:b": "idle" },
      coord: coord({ maintaining: [{ session: "proj:b", note: "owned issues complete", at: 0 }] }),
      tabs: [{ paneIds: ["proj:a", "proj:b"] }], disabledPanes: {}, profiles: [],
    });
    expect(workers.find(w => w.name === "b")!.status).toBe("maintenance");
    expect(statusCounts(workers)).toEqual({ running: 1, maintenance: 1 });
    expect(deriveFleetKpis(workers)).toEqual({ total: 2, active: 1, needAttention: 0, idle: 0, maintenance: 1 });
  });
});
