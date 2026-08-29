// Unit tests for promote selection. These cover the guards that decide whether the RUNNING app's
// checkout moves, so a mistake here either disturbs the user mid-session — the exact thing this
// feature exists to stop — or destroys uncommitted work in the app tree.
import { describe, expect, it } from "vitest";
import { planPromote } from "./promote-plan.mjs";

const state = (over: Record<string, unknown> = {}) => ({
  treeExists: true,
  branch: "main",
  dirty: [] as string[],
  ahead: 0,
  behind: 3,
  ...over,
});

describe("planPromote", () => {
  it("promotes when the app tree is clean and simply behind develop", () => {
    expect(planPromote(state())).toEqual({ action: "promote", reason: "behind" });
  });

  it("does nothing when the app tree already matches develop", () => {
    expect(planPromote(state({ behind: 0 }))).toEqual({ action: "noop", reason: "already-current" });
  });

  it("refuses when there is no app worktree at all", () => {
    expect(planPromote(state({ treeExists: false })).action).toBe("fail");
  });

  /// A detached HEAD has no branch to fast-forward. Guessing which ref was meant is exactly the kind
  /// of helpfulness that moves the running app somewhere nobody chose.
  it("refuses a detached HEAD rather than guessing a ref", () => {
    expect(planPromote(state({ branch: "HEAD" }))).toEqual({ action: "fail", reason: "detached-head" });
    expect(planPromote(state({ branch: null }))).toEqual({ action: "fail", reason: "detached-head" });
  });

  /// Someone edited the RUNNING copy. Promoting would either fail or carry those edits forward
  /// silently, and the uncommitted work is the only thing here that cannot be recovered.
  it("refuses to promote over uncommitted work in the app tree", () => {
    expect(planPromote(state({ dirty: [" M src/app/App.tsx"] }))).toEqual({
      action: "fail",
      reason: "dirty-app-tree",
    });
  });

  /// The running app must be a PREFIX of develop's history. If it is ahead, something committed
  /// straight to it — a fault to look at, never one to paper over with a merge commit.
  it("refuses when the app branch is AHEAD of develop, so no fast-forward exists", () => {
    expect(planPromote(state({ ahead: 2, behind: 0 }))).toEqual({
      action: "fail",
      reason: "app-tree-ahead",
    });
    // ahead AND behind — diverged — is still a refusal, never a merge.
    expect(planPromote(state({ ahead: 2, behind: 5 })).action).toBe("fail");
  });

  /// Precedence: a dirty tree outranks being ahead, because the uncommitted work is the thing the
  /// user can still lose and the thing they need told about first.
  it("reports a dirty tree ahead of an ahead-branch when both are true", () => {
    expect(planPromote(state({ dirty: [" M x.ts"], ahead: 2 })).reason).toBe("dirty-app-tree");
  });

  it("never promotes on a malformed or empty state", () => {
    expect(planPromote(undefined as never).action).toBe("fail");
    expect(planPromote({} as never).action).toBe("fail");
  });
});
