import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Unit tests for promote selection. These cover the guards that decide whether the RUNNING app's
// checkout moves, so a mistake here either disturbs the user mid-session — the exact thing this
// feature exists to stop — or destroys uncommitted work in the app tree.
import { describe, expect, it } from "vitest";
import { classifyGateFailure, gateTreeMoved, planPromote, treeMovedMessage } from "./promote-plan.mjs";

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

  /// The one assumption the script is NAMED for, and the only one it never checked.
  ///
  /// MEASURED 2026-09-01: the repo root had been left on a work branch cut from develop, so `behind`
  /// was 0 and promote reported "already matches develop — nothing to promote" and exited 0 while
  /// `main` sat five commits back. A silent, GREEN failure is worse than any refusal this already has.
  it("refuses when the root is on a branch that is not the app branch", () => {
    expect(planPromote(state({ branch: "a-work-branch", behind: 0 }))).toEqual({
      action: "fail",
      reason: "wrong-app-branch",
    });
    // And it fires REGARDLESS of distance — the old bug's whole shape was `behind: 0` reading as
    // "nothing to do" when the number was about the wrong ref.
    expect(planPromote(state({ branch: "a-work-branch", behind: 9 })).reason).toBe("wrong-app-branch");
  });

  /// The tree-moved check stays, and stays UNSOUND to weaken.
  ///
  /// Three consecutive promotes each gated clean and each was refused because the shared integration
  /// tree moved mid-gate; `main` drifted from 8 commits behind to 22 during the attempts. The tempting
  /// "fix" is to accept a tree that moved by COMPLETE merges and refuse only a half-merged one — but if
  /// HEAD moves while the gate runs, the compiler and the test runner read files ACROSS the change, so
  /// what got compiled is a mixture that exists in no commit whether or not both endpoints are clean.
  /// The real fix is to gate somewhere that cannot move, which is what `gateTree` does; this pins that
  /// the verdict is still refused whenever it DOES move.
  it("treats any movement under the gate as untrustworthy, not just a dirty tree", () => {
    expect(gateTreeMoved("aaa", "bbb").moved).toBe(true);
    expect(gateTreeMoved("aaa", "aaa").moved).toBe(false);
    // Unreadable is moved: not knowing whether it moved is not the same as knowing it did not.
    expect(gateTreeMoved(null, "aaa").moved).toBe(true);
    expect(gateTreeMoved("aaa", null).moved).toBe(true);
  });

  /// Opting out is explicit, so a caller that legitimately promotes another ref still can.
  it("allows any branch when appBranch is null", () => {
    expect(planPromote(state({ branch: "a-work-branch", behind: 3, appBranch: null })).action).toBe("promote");
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

/**
 * A promote forced to choose between one stale data file and skipping ALL verification is the state
 * this closes. MEASURED 2026-09-01: `graph-promote-check` was red all day on a rotating node while
 * every other leg passed, so every promote that day went through `--skip-gate` — which does not skip
 * that leg, it skips verifying develop entirely.
 */
describe("classifyGateFailure", () => {
  const STARTED = Date.parse("2026-09-01T15:00:00Z");
  const finishedAt = "2026-09-01T15:04:00Z";
  const DECLARED = { "graph-promote-check": { ref: "develop-is-red-the-repo-graph-store-is-behind" } };

  const legs = (...red: string[]) =>
    ["typecheck", "lint", "vitest", "clippy", "nextest", "graph-promote-check"].map((key) => ({
      key,
      ok: !red.includes(key),
    }));

  it("proceeds when every red leg is declared, and names the owning item", () => {
    const v = classifyGateFailure({ finishedAt, legs: legs("graph-promote-check") }, DECLARED, STARTED);
    expect(v.proceed).toBe(true);
    expect(v.reason).toBe("all-red-legs-declared");
    expect(v.explained).toEqual([
      { key: "graph-promote-check", ref: "develop-is-red-the-repo-graph-store-is-behind" },
    ]);
    expect(v.unexplained).toEqual([]);
  });

  it("refuses when ANY red leg is undeclared, even alongside a declared one", () => {
    const v = classifyGateFailure({ finishedAt, legs: legs("graph-promote-check", "nextest") }, DECLARED, STARTED);
    expect(v.proceed).toBe(false);
    expect(v.reason).toBe("unexplained-red");
    expect(v.unexplained).toEqual(["nextest"]);
  });

  it("refuses with nothing declared at all — the safe direction when the store cannot be read", () => {
    const v = classifyGateFailure({ finishedAt, legs: legs("graph-promote-check") }, {}, STARTED);
    expect(v.proceed).toBe(false);
    expect(v.unexplained).toEqual(["graph-promote-check"]);
  });

  /** An absent verdict reads as ABSENT, never as a pass — the same rule `bsc work gate` states. */
  it("refuses when there is no readable verdict", () => {
    expect(classifyGateFailure(null, DECLARED, STARTED).reason).toBe("no-verdict");
    expect(classifyGateFailure({ finishedAt }, DECLARED, STARTED).reason).toBe("no-verdict");
  });

  /** A stale artifact is worse than none, because it looks authoritative. */
  it("refuses a verdict that predates this run", () => {
    const v = classifyGateFailure(
      { finishedAt: "2026-09-01T14:59:59Z", legs: legs("graph-promote-check") },
      DECLARED,
      STARTED,
    );
    expect(v.proceed).toBe(false);
    expect(v.reason).toBe("stale-verdict");
  });

  it("refuses a verdict with no parseable finish time rather than assuming it is this one", () => {
    expect(classifyGateFailure({ legs: legs("graph-promote-check") }, DECLARED, STARTED).reason).toBe("stale-verdict");
  });

  /** The gate failed around the legs — a lock, a crash, gate-tree-guard. No declaration covers that. */
  it("never excuses a failure that no leg accounts for", () => {
    const v = classifyGateFailure({ finishedAt, legs: legs() }, DECLARED, STARTED);
    expect(v.proceed).toBe(false);
    expect(v.reason).toBe("failed-outside-the-legs");
  });

  /** A declaration explains a failure; it never launders one. The leg is still reported red. */
  it("reports the declared leg as red rather than dropping it from the account", () => {
    const v = classifyGateFailure({ finishedAt, legs: legs("graph-promote-check") }, DECLARED, STARTED);
    expect(v.explained).toHaveLength(1);
    expect(v.explained[0].key).toBe("graph-promote-check");
  });
});

/**
 * MEASURED 2026-09-01 ~10:59: a promote gate compiled `wt-integrate` while another session merged into
 * it and reported `nextest FAIL — this file contains an unclosed delimiter`, naming a real file and
 * line. The file's brace balance is 0 at every commit that ever touched it; a re-gate minutes later
 * passed 4127 tests. `bsc plan integrate`'s lock stops two merges racing and the gate slot bounds
 * memory; neither is held against the other.
 */
describe("gateTreeMoved", () => {
  it("trusts a verdict when HEAD did not move", () => {
    expect(gateTreeMoved("abc123", "abc123")).toEqual({ moved: false, reason: "head-stable" });
  });

  it("distrusts a verdict when a merge landed mid-gate", () => {
    const v = gateTreeMoved("abc123", "def456");
    expect(v.moved).toBe(true);
    expect(v.reason).toBe("head-moved");
  });

  /** A check that cannot see the tree must not certify it. The cost is a re-run; the alternative is
   *  exactly the silent false confidence this exists to remove. */
  it("treats an unreadable HEAD as moved rather than as stable", () => {
    expect(gateTreeMoved(null, "def456").reason).toBe("head-unreadable");
    expect(gateTreeMoved("abc123", null).reason).toBe("head-unreadable");
    expect(gateTreeMoved(null, null).moved).toBe(true);
  });

  /** The direction the incident did NOT produce, and the more dangerous one: a PASS over a half-merged
   *  tree promotes on a verification of a state that exists in no commit. `gateTreeMoved` is asked
   *  before the verdict's colour is known, so both are covered by construction. */
  it("is a statement about the tree, not about the verdict's colour", () => {
    expect(gateTreeMoved("abc", "def").moved).toBe(true);
    expect(gateTreeMoved("abc", "abc").moved).toBe(false);
  });

  it("names both shas and says nothing was moved, so the reader knows to re-run", () => {
    const msg = treeMovedMessage(gateTreeMoved("abc123", "def456"), "/repo/wt-integrate");
    expect(msg).toContain("UNTRUSTWORTHY");
    expect(msg).toContain("abc123");
    expect(msg).toContain("def456");
    expect(msg).toContain("/repo/wt-integrate");
    expect(msg).toContain("Nothing was moved");
    expect(msg).toContain("re-run");
  });

  it("says which of the two cases it is, rather than one message for both", () => {
    const unreadable = treeMovedMessage(gateTreeMoved(null, null), "/repo/wt-integrate");
    expect(unreadable).toContain("could not read HEAD");
    expect(unreadable).not.toContain("moved while it ran");
  });

  /**
   * THE RACE ITSELF, reproduced against a real repository rather than asserted over two strings.
   *
   * A commit lands between the two `git rev-parse HEAD` reads — which is precisely what a concurrent
   * `bsc plan integrate` does to the shared tree — and the check reports it. Run against a scratch repo
   * on purpose: reproducing it in `wt-integrate` would mean moving develop's HEAD under every other
   * session gating at that moment, which is the hazard this item is about.
   */
  it("reports a commit that lands between the two reads of a real repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "promote-race-"));
    try {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
      git("init", "-q", "-b", "main");
      git("config", "user.email", "t@example.test");
      git("config", "user.name", "t");
      writeFileSync(join(dir, "a.txt"), "one");
      git("add", "-A");
      git("commit", "-qm", "one");

      const before = git("rev-parse", "HEAD");
      expect(gateTreeMoved(before, git("rev-parse", "HEAD")).moved).toBe(false);

      // …another session merges into the shared tree while the gate is running.
      writeFileSync(join(dir, "a.txt"), "two");
      git("commit", "-qam", "a merge landing mid-gate");

      const after = git("rev-parse", "HEAD");
      expect(after).not.toBe(before);
      const v = gateTreeMoved(before, after);
      expect(v.moved).toBe(true);
      expect(treeMovedMessage(v, dir)).toContain(after);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
