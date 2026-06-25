import { describe, it, expect } from "vitest";
import { classifyWorkerEnd, type OwnedIssue } from "./workerEnd";
import { emptyCoordState, satisfy, parseRef, type CoordState } from "./coordination";

const empty = emptyCoordState();
const iss = (ref: string, status: string): OwnedIssue => ({ ref, status });

/** A coord state with the given refs satisfied (landed/merged). */
function landed(...refs: string[]): CoordState {
  let s = emptyCoordState();
  for (const r of refs) {
    const ref = parseRef(r);
    if (ref) s = satisfy(s, ref, "merged", 0).state;
  }
  return s;
}

describe("classifyWorkerEnd (#920)", () => {
  it("is needs-attention when there are no owned issues (can't confirm)", () => {
    expect(classifyWorkerEnd([], empty)).toEqual({
      state: "needs-attention",
      summary: expect.stringMatching(/no owned issues/i),
    });
  });

  it("is done when every owned issue is complete/verified", () => {
    const v = classifyWorkerEnd([iss("#1", "complete"), iss("#2", "verified")], empty);
    expect(v.state).toBe("done");
    expect(v.summary).toMatch(/2\/2 complete/);
  });

  it("reports the landed count (coord.log tiebreaker) in the done summary", () => {
    const v = classifyWorkerEnd([iss("#1", "complete"), iss("#2", "complete")], landed("#1"));
    expect(v.state).toBe("done");
    expect(v.summary).toMatch(/1\/2 landed/);
  });

  it("is needs-attention (stopped early) when any issue is still open/in_progress", () => {
    const v = classifyWorkerEnd([iss("#1", "complete"), iss("#2", "in_progress")], empty);
    expect(v.state).toBe("needs-attention");
    expect(v.summary).toMatch(/stopped early/i);
  });

  it("is blocked when any issue is blocked/failed — even with others open", () => {
    const v = classifyWorkerEnd([iss("#1", "failed"), iss("#2", "open"), iss("#3", "complete")], empty);
    expect(v.state).toBe("blocked"); // blocked precedence over needs-attention
    expect(v.summary).toMatch(/1\/3 blocked or failed/);
  });

  it("treats an unknown status as not-done (conservative)", () => {
    const v = classifyWorkerEnd([iss("#1", "complete"), iss("#2", "weird")], empty);
    expect(v.state).toBe("needs-attention");
  });
});
