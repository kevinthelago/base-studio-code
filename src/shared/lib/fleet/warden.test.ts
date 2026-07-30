import { describe, it, expect } from "vitest";
import { allChanges } from "./worktreeChanges";
import { planWarden, summarizeTrips, parseAuditCommands, type WardenSession, zipWorktreeChanges, wardenSweepTargets, livePaneIdsOf } from "./warden";
import { roleCapability } from "../session/sessionRoles";
import { DEFAULT_FLOW } from "@/features/planner/fleet/agentFlow";

function session(paneId: string, over: Partial<WardenSession["activity"]> = {}): WardenSession {
  return {
    paneId,
    anchor: {
      streamId: "api",
      ownedGlobs: ["src/api/**"],
      capability: roleCapability("worker", { writeGlobs: ["src/api/**"] }),
      flow: DEFAULT_FLOW, // auto-pr
    },
    activity: { changedFiles: [], commands: [], ...over },
  };
}

describe("summarizeTrips", () => {
  it("renders one trip, and counts the rest", () => {
    expect(summarizeTrips([])).toBe("on plan");
    expect(summarizeTrips([{ kind: "out-of-glob", detail: "src/web/x.tsx" }]))
      .toBe("edited out-of-lane src/web/x.tsx");
    expect(summarizeTrips([
      { kind: "denied-command", detail: "gh repo delete acme/api" },
      { kind: "out-of-glob", detail: "src/web/x.tsx" },
    ])).toBe("ran denied `gh repo delete acme/api` (+1 more)");
  });
});

describe("parseAuditCommands", () => {
  const lines = [
    "2026-06-22T10:00:00Z\tt0p1\tbash\tgit status",
    "2026-06-22T10:00:01Z\tt0p1\tRead\t/src/api/x.ts",       // not a command (Read tool)
    "2026-06-22T10:00:02Z\tt0p2\tbash\tgh pr merge 3",        // other pane
    "2026-06-22T10:00:03Z\tt0p1\tBash\tgh repo delete acme",  // case-insensitive tool
    "malformed line",
  ];
  it("extracts only this pane's Bash commands", () => {
    expect(parseAuditCommands(lines, "t0p1")).toEqual(["git status", "gh repo delete acme"]);
    expect(parseAuditCommands(lines, "t0p2")).toEqual(["gh pr merge 3"]);
  });
  it("drops commands logged before the `since` floor (triage relaunch ignores stale denials)", () => {
    const since = Date.parse("2026-06-22T10:00:02Z"); // floor between the two t0p1 rows
    expect(parseAuditCommands(lines, "t0p1", since)).toEqual(["gh repo delete acme"]);
    expect(parseAuditCommands(lines, "t0p1", 0)).toEqual(["git status", "gh repo delete acme"]); // 0 = no floor
  });
});

describe("planWarden", () => {
  it("quarantines a session that trips; leaves on-plan ones alone", () => {
    const clean = session("t0p1", { changedFiles: ["src/api/ok.ts"], commands: ["git commit -m x"] });
    const drifted = session("t0p2", { changedFiles: ["src/web/app.tsx"], commands: ["gh pr merge 3"] });
    const trips = planWarden([clean, drifted], new Set());
    expect(trips.map((t) => t.paneId)).toEqual(["t0p2"]);
    expect(trips[0].streamId).toBe("api");
    expect(trips[0].summary).toContain("out-of-lane src/web/app.tsx");
  });

  it("never re-trips an already-quarantined pane (one-shot hard pause)", () => {
    const drifted = session("t0p2", { changedFiles: ["src/web/app.tsx"] });
    expect(planWarden([drifted], new Set(["t0p2"]))).toEqual([]);
  });

  it("an auto-pr worker opening its PR is not a trip", () => {
    const ok = session("t0p1", { commands: ["git push origin api", "gh pr create --title done"] });
    expect(planWarden([ok], new Set())).toEqual([]);
  });
});

/** #3983: the batch now returns tracked/untracked split; the lane check reads TRACKED. */
const tc = (...tracked: string[]) => ({ tracked, untracked: [] });

describe("zipWorktreeChanges (#3908) — the batched worktree read must not misattribute files", () => {
  it("maps each pane to its OWN index", () => {
    const m = zipWorktreeChanges(["a", "b", "c"], [tc("1.ts"), tc("2.ts"), tc("3.ts")]);
    expect(m.get("a")).toEqual(["1.ts"]);
    expect(m.get("b")).toEqual(["2.ts"]);
    expect(m.get("c")).toEqual(["3.ts"]);
  });

  it("degrades a missing/short entry to NO file signal — never a neighbour's files", () => {
    // A truncated batch (backend hiccup) must leave the tail with no evidence rather than shifting
    // results up a slot, which would quarantine the wrong worker.
    const m = zipWorktreeChanges(["a", "b", "c"], [tc("1.ts")]);
    expect(m.get("a")).toEqual(["1.ts"]);
    expect(m.get("b")).toEqual([]);
    expect(m.get("c")).toEqual([]);
    // Every requested pane is still present — the warden iterates panes, not results.
    expect([...m.keys()]).toEqual(["a", "b", "c"]);
  });

  it("an empty fleet zips to an empty map", () => {
    expect(zipWorktreeChanges([], []).size).toBe(0);
  });
});

describe("wardenSweepTargets / livePaneIdsOf (#3954)", () => {
  const tabs = [{ paneIds: ["p:a", "p:b", "p:director"] }];

  it("probes ONLY panes with a running session", () => {
    // The measured bug: the sweep took the planned roster (47 panes) while 3 terminals were live,
    // and every pane costs two git subprocesses — ~94 serial spawns that stalled the whole queue.
    const planned = ["p:a", "p:b", "p:c", "p:d", "p:e"];
    const live = livePaneIdsOf(tabs, {}, {});
    expect(wardenSweepTargets(planned, live, new Set())).toEqual(["p:a", "p:b"]);
  });

  it("still skips a COMPLETED worker even when it is live", () => {
    // Completed workers stand by in maintenance and must never be (re)quarantined.
    const live = livePaneIdsOf(tabs, {}, {});
    expect(wardenSweepTargets(["p:a", "p:b"], live, new Set(["p:b"]))).toEqual(["p:a"]);
  });

  it("treats an ENDED or DISABLED pane as not live", () => {
    expect([...livePaneIdsOf(tabs, { "p:a": true }, {})].sort()).toEqual(["p:b", "p:director"]);
    expect([...livePaneIdsOf(tabs, {}, { "p:b": true })].sort()).toEqual(["p:a", "p:director"]);
  });

  it("a fleet with nothing running sweeps nothing — no git spawns at all", () => {
    expect(wardenSweepTargets(["p:a", "p:b"], new Set(), new Set())).toEqual([]);
  });

  it("agrees with the Glance/pump liveness definition (in a tab, not ended, not disabled)", () => {
    const multi = [{ paneIds: ["x:1"] }, { paneIds: ["y:1", undefined as unknown as string] }];
    expect([...livePaneIdsOf(multi, {}, {})].sort()).toEqual(["x:1", "y:1"]);
  });

  it("a pane in the roster but in NO tab is not swept", () => {
    // The exact shape of the bug: plan.db knows 38 streams, the tab holds 3.
    const live = livePaneIdsOf([{ paneIds: ["p:a"] }], {}, {});
    expect(wardenSweepTargets(["p:a", "p:b", "p:c"], live, new Set())).toEqual(["p:a"]);
  });
});

describe("the lane check reads TRACKED changes only (#3983)", () => {
  it("untracked scratch is NOT a lane signal", () => {
    // Measured: `algorithms` had 0 tracked changes and 21 untracked (.tmp-agent/*.log), `skills` 0
    // and 10 (.agentscratch*.txt). Both were quarantined — PTY killed — for files that never entered
    // the repo and could not collide at integration.
    const m = zipWorktreeChanges(["a"], [{ tracked: [], untracked: [".agentscratch.txt", ".tmp-agent/x.log"] }]);
    expect(m.get("a")).toEqual([]);
  });

  it("a tracked out-of-lane edit IS still a lane signal", () => {
    const m = zipWorktreeChanges(["a"], [{ tracked: ["src/other/thing.ts"], untracked: [] }]);
    expect(m.get("a")).toEqual(["src/other/thing.ts"]);
  });

  it("reports only the tracked half when a worker has both", () => {
    // The self-correcting property: scratch stays invisible, real edits are seen. Commit the scratch
    // and it becomes tracked — and trips then, still before integration.
    const m = zipWorktreeChanges(["a"], [{ tracked: ["src/a/x.ts"], untracked: ["notes.txt"] }]);
    expect(m.get("a")).toEqual(["src/a/x.ts"]);
  });

  it("allChanges() keeps the union for the UI's uncommitted-changes view", () => {
    expect(allChanges({ tracked: ["a.ts"], untracked: ["b.txt"] })).toEqual(["a.ts", "b.txt"]);
    expect(allChanges(undefined)).toEqual([]);
  });
});
