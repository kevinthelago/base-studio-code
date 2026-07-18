// planResumeLaunch (#glance-resume) — the progress-gated stream partition a Glance project-resume runs.
// Pure, so it's exhaustively unit-testable without any Tauri/store IO.
import { describe, it, expect } from "vitest";
import { planResumeLaunch } from "./resumeProject";
import type { FleetPlan, AgentStream } from "@/features/planner/fleet/planFleet";

function stream(over: Partial<AgentStream> = {}): AgentStream {
  return { id: "api", name: "api", repo: "acme/api", owns: [], issues: [], dependsOn: [], ...over };
}
function fleet(streams: AgentStream[], directorEnabled = true): FleetPlan {
  return { recommended: streams.length, reasoning: "", director: { enabled: directorEnabled }, streams };
}

describe("planResumeLaunch (#glance-resume)", () => {
  it("keeps a stream with outstanding work ACTIVE (its issues aren't all done)", () => {
    const f = fleet([stream({ id: "api", issues: ["#1", "#2"] })]);
    const dbIssues = [{ ref: "#1", stream: "api", status: "complete" }, { ref: "#2", stream: "api", status: "in-progress" }];
    const { launchPlan, maintenanceIds } = planResumeLaunch(f, dbIssues);
    expect(launchPlan.streams.map((s) => s.id)).toEqual(["api"]);
    expect(maintenanceIds.has("api")).toBe(false);
  });

  it("relaunches a fully-done stream INTO maintenance (still launched, flagged, noted)", () => {
    const f = fleet([stream({ id: "api", issues: ["#1", "#2"] })]);
    const dbIssues = [{ ref: "#1", stream: "api", status: "complete" }, { ref: "#2", stream: "api", status: "verified" }];
    const { launchPlan, maintenanceIds, note } = planResumeLaunch(f, dbIssues);
    // #1957: a completed worker relaunches (into maintenance), it is NOT skipped.
    expect(launchPlan.streams.map((s) => s.id)).toEqual(["api"]);
    expect(maintenanceIds.has("api")).toBe(true);
    expect(note).toContain("maintenance");
  });

  it("drops a stream with no repo and reports it, keeping the ones that can launch", () => {
    const f = fleet([stream({ id: "api", repo: "acme/api" }), stream({ id: "web", repo: "" })]);
    const { launchPlan, noRepo, note } = planResumeLaunch(f, []);
    expect(launchPlan.streams.map((s) => s.id)).toEqual(["api"]);
    expect(noRepo).toEqual(["web"]);
    expect(note).toContain("no repo assigned");
  });

  it("enriches a stream's issue list from plan.db when the stream lists none (#2615)", () => {
    const f = fleet([stream({ id: "api", issues: [] })]);
    const dbIssues = [{ ref: "#7", stream: "api", status: "in-progress" }];
    const { launchPlan } = planResumeLaunch(f, dbIssues);
    expect(launchPlan.streams[0].issues).toContain("#7");
  });

  it("returns no streams (director may still carry the launch) when every stream is repo-less", () => {
    const f = fleet([stream({ id: "api", repo: "" })], true);
    const { launchPlan, noRepo } = planResumeLaunch(f, []);
    expect(launchPlan.streams).toHaveLength(0);
    expect(noRepo).toEqual(["api"]);
    expect(launchPlan.director.enabled).toBe(true);
  });
});
