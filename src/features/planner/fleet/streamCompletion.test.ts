import { describe, it, expect } from "vitest";
import { doneIssueRefs, streamComplete, pruneCompletedStreams } from "./streamCompletion";
import type { AgentStream } from "./planFleet";
import type { PlanIssue } from "../issues/planIssues";

const issue = (ref: string, status?: PlanIssue["status"]): PlanIssue => ({
  ref, title: ref, acceptance: [], owns: [], dependsOn: [], labels: [], status,
});
const stream = (id: string, issues: string[]): AgentStream => ({
  id, name: id, repo: "o/r", owns: [], issues, dependsOn: [],
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
    const { active, skipped } = pruneCompletedStreams(streams, done);
    expect(active.map((s) => s.id)).toEqual(["partial", "fresh", "standing"]);
    expect(skipped.map((s) => s.id)).toEqual(["done"]);
  });

  it("first launch (nothing done) → every stream is active", () => {
    const { active, skipped } = pruneCompletedStreams(
      [stream("a", ["A"]), stream("b", ["B"])],
      new Set(),
    );
    expect(active).toHaveLength(2);
    expect(skipped).toHaveLength(0);
  });
});
