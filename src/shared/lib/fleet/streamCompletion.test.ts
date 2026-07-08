import { describe, it, expect } from "vitest";
import { doneIssueRefs, streamComplete, pruneCompletedStreams, completedWorkerPanes, projectComplete } from "./streamCompletion";
import type { AgentStream } from "@/features/planner/fleet/planFleet";
import type { PlanIssue } from "@/features/planner/issues/planIssues";

const issue = (ref: string, status?: PlanIssue["status"]): PlanIssue => ({
  ref, title: ref, acceptance: [], owns: [], dependsOn: [], labels: [], status,
});
const stream = (id: string, issues: string[]): AgentStream => ({
  id, name: id, repo: "o/r", owns: [], issues, dependsOn: [],
});

describe("projectComplete (#2619 — the application-complete banner signal)", () => {
  it("is true only when there are issues and every one is complete/verified", () => {
    expect(projectComplete([issue("A", "complete"), issue("B", "verified")])).toBe(true);
    expect(projectComplete([issue("A", "complete"), issue("B")])).toBe(false); // one still open
    expect(projectComplete([])).toBe(false);                                   // nothing planned yet ≠ complete
  });
});

describe("doneIssueRefs (#1004)", () => {
  it("collects only complete / verified refs", () => {
    const done = doneIssueRefs([
      issue("A", "complete"), issue("B", "verified"),
      issue("C", "in_progress"), issue("D", "blocked"), issue("E"),
    ]);
    expect([...done].sort()).toEqual(["A", "B"]);
  });
});

describe("streamComplete (#1004)", () => {
  const done = new Set(["A", "B"]);
  it("true only when every owned issue is done", () => {
    expect(streamComplete(stream("s1", ["A", "B"]), done)).toBe(true);
    expect(streamComplete(stream("s2", ["A", "C"]), done)).toBe(false);
  });
  it("a stream that owns no issues is never complete (let it launch)", () => {
    expect(streamComplete(stream("s3", []), done)).toBe(false);
  });
});

describe("pruneCompletedStreams (#1004)", () => {
  it("keeps streams with outstanding work, skips finished ones, preserves order", () => {
    const done = new Set(["A", "B"]);
    const streams = [
      stream("done", ["A", "B"]),
      stream("partial", ["A", "C"]),
      stream("fresh", ["X"]),
      stream("standing", []),
    ];
    const { active, maintenance } = pruneCompletedStreams(streams, done);
    expect(active.map((s) => s.id)).toEqual(["partial", "fresh", "standing"]);
    expect(maintenance.map((s) => s.id)).toEqual(["done"]); // completed → relaunch into maintenance (#1957)
  });

  it("first launch (nothing done) → every stream is active", () => {
    const { active, maintenance } = pruneCompletedStreams(
      [stream("a", ["A"]), stream("b", ["B"])],
      new Set(),
    );
    expect(active).toHaveLength(2);
    expect(maintenance).toHaveLength(0);
  });
});

describe("completedWorkerPanes (warden un-quarantine of finished workers)", () => {
  const fleetPaneStreams = {
    "proj:auth": stream("auth", ["A", "B"]), // every issue done → completed
    "proj:api":  stream("api", ["A", "C"]),  // C outstanding → still building
    "proj:ui":   stream("ui", []),           // owns nothing → never "completed"
  };
  // The pane id is `<projectKey>:<streamId>`, so the project key selects the per-project done set.
  const doneFor = (paneId: string) =>
    new Map([["proj", new Set(["A", "B"])]]).get(paneId.split(":")[0]);

  it("marks only panes whose stream finished every owned issue", () => {
    expect([...completedWorkerPanes(fleetPaneStreams, doneFor)]).toEqual(["proj:auth"]);
  });

  it("marks nothing when the project's done set is unknown (no plan.db read yet)", () => {
    expect(completedWorkerPanes(fleetPaneStreams, () => undefined).size).toBe(0);
  });
});
