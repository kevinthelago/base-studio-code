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
  // ── the doom loop (#promote-refuses-forever-because-hand-merges-made-fast-forward-impossible) ──

  it("reconciles when every ahead commit is a merge and the trees are identical", () => {
    // MEASURED: main was 17 ahead, all 17 merge commits, trees byte-identical. Nothing had been
    // committed straight to main — the old refusal's accusation was simply false, and each hand-merge
    // that caused it made the NEXT --ff-only impossible, so the loop fed itself seventeen times.
    expect(planPromote(state({ ahead: 17, aheadContent: 0, aheadAddsNothing: true, behind: 0 }))).toEqual({
      action: "reconcile",
      reason: "app-tree-ahead-by-merges-only",
    });
  });

  it("still reconciles once DEVELOP has moved ahead — the case the first implementation got wrong", () => {
    // THE REGRESSION, and the reason the criterion is idempotence rather than "it worked once". The
    // first version asked whether the two ref trees were IDENTICAL, which is false the moment develop
    // gains a commit — i.e. after any integration, which is every real promotion. It fired only in the
    // one state where develop had not moved since the last promote, and refused in exactly the state
    // the feature exists for. `aheadAddsNothing` asks what the APP REF contributed, so develop moving
    // is irrelevant to it.
    expect(planPromote(state({ ahead: 18, aheadContent: 0, aheadAddsNothing: true, behind: 2 }))).toEqual({
      action: "reconcile",
      reason: "app-tree-ahead-by-merges-only",
    });
  });

  it("still REFUSES a real content commit on the app branch — the guard is made precise, not weaker", () => {
    // The fault the refusal was written for. One content commit is enough, however many merges sit
    // beside it, because that commit is history develop genuinely does not have.
    expect(planPromote(state({ ahead: 17, aheadContent: 1, aheadAddsNothing: true }))).toEqual({
      action: "fail",
      reason: "app-tree-ahead",
    });
  });

  it("refuses when the commits look like merges but the app ref ADDED something", () => {
    // A merge carries no content of its own, yet can still resolve to a tree the merge base did not
    // have — a conflict resolved by hand, or an --ours. Merging back on the commit shape alone would
    // go over that resolution and lose it silently. Both signals, or refuse.
    expect(planPromote(state({ ahead: 3, aheadContent: 0, aheadAddsNothing: false }))).toEqual({
      action: "fail",
      reason: "app-tree-ahead",
    });
  });

  it("assumes every ahead commit is real when the caller cannot say", () => {
    // The defaults are the PESSIMISTIC answer on purpose: an older caller, or one that could not ask
    // git, gets exactly the historical refusal rather than an accidental reconcile.
    expect(planPromote(state({ ahead: 2 }))).toEqual({ action: "fail", reason: "app-tree-ahead" });
    expect(planPromote(state({ ahead: 2, aheadAddsNothing: true }))).toEqual({ action: "fail", reason: "app-tree-ahead" });
  });

  it("keeps a dirty tree ahead of a reconcilable divergence", () => {
    // Precedence is unchanged: uncommitted work is the thing the user can still lose, so it is
    // reported first even when the divergence beneath it would have been repairable.
    expect(planPromote(state({ dirty: ["M x"], ahead: 5, aheadContent: 0, aheadAddsNothing: true }))).toEqual({
      action: "fail",
      reason: "dirty-app-tree",
    });
  });

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

  /// `dirty` carries TRACKED modifications only. A fast-forward cannot destroy an untracked file, so
  /// counting them here refused every promote over 0-byte editor/shell dotfiles a tooling sandbox
  /// leaves at the repo root — a guard that never lets you through is not a guard.
  it("treats only tracked modifications as dirty", () => {
    expect(planPromote(state({ dirty: [" M src/app/App.tsx"] })).reason).toBe("dirty-app-tree");
    // The caller passes an untracked-free list; an empty one must promote.
    expect(planPromote(state({ dirty: [] })).action).toBe("promote");
  });

  it("never promotes on a malformed or empty state", () => {
    expect(planPromote(undefined as never).action).toBe("fail");
    expect(planPromote({} as never).action).toBe("fail");
  });
});
