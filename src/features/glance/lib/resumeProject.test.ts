// planResumeLaunch (#glance-resume) — the progress-gated stream partition a Glance project-resume runs.
// Pure, so it's exhaustively unit-testable without any Tauri/store IO.
import { describe, it, expect } from "vitest";
import { planResumeLaunch, partitionResumable } from "./resumeProject";
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

describe("partitionResumable (#3916) — resume what can run, SURFACE what can't", () => {
  const none = { quarantined: {}, missingWorktreePanes: new Set<string>() };
  const streams = [{ id: "api" }, { id: "ui" }, { id: "db" }];

  it("resumes every stream when nothing is blocked", () => {
    const { resumable, blocked } = partitionResumable(streams, "proj", none);
    expect(resumable.map((s) => s.id)).toEqual(["api", "ui", "db"]);
    expect(blocked).toEqual([]);
  });

  it("BLOCKS a quarantined session and carries the warden's summary — never silently resumes it", () => {
    const { resumable, blocked } = partitionResumable(streams, "proj", {
      ...none,
      quarantined: { "proj:ui": { summary: "wrote outside its lane" } },
    });
    expect(resumable.map((s) => s.id)).toEqual(["api", "db"]);
    expect(blocked).toEqual([{ streamId: "ui", paneId: "proj:ui", reason: "wrote outside its lane" }]);
  });

  it("falls back to a readable reason when the quarantine has no summary", () => {
    const { blocked } = partitionResumable([{ id: "ui" }], "proj", { ...none, quarantined: { "proj:ui": {} } });
    expect(blocked[0].reason).toBe("quarantined by the warden");
  });

  it("BLOCKS a stream whose worktree is gone — #3614: never spawn into a missing cwd", () => {
    const { resumable, blocked } = partitionResumable(streams, "proj", {
      ...none,
      missingWorktreePanes: new Set(["proj:db"]),
    });
    expect(resumable.map((s) => s.id)).toEqual(["api", "ui"]);
    expect(blocked[0]).toMatchObject({ streamId: "db", paneId: "proj:db" });
    expect(blocked[0].reason).toMatch(/worktree/i);
  });

  it("quarantine outranks a missing worktree — the warden's reason is the one to act on", () => {
    const { blocked } = partitionResumable([{ id: "ui" }], "proj", {
      quarantined: { "proj:ui": { summary: "denied command" } },
      missingWorktreePanes: new Set(["proj:ui"]),
    });
    expect(blocked).toHaveLength(1);
    expect(blocked[0].reason).toBe("denied command");
  });

  it("an all-blocked fleet resumes nothing (the caller reports, it does not launch)", () => {
    const { resumable, blocked } = partitionResumable(streams, "proj", {
      quarantined: { "proj:api": {}, "proj:ui": {}, "proj:db": {} },
      missingWorktreePanes: new Set(),
    });
    expect(resumable).toEqual([]);
    expect(blocked).toHaveLength(3);
  });
});
