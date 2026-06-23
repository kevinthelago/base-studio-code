import { describe, it, expect } from "vitest";
import { planWarden, summarizeTrips, parseAuditCommands, type WardenSession } from "./warden";
import { roleCapability } from "../session/sessionRoles";
import { DEFAULT_FLOW } from "../../screens/planner/fleet/agentFlow";

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
