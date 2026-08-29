// Unit tests for the ref guard. It decides whether the RUNNING app's branch may move, so a mistake
// here either interrupts the maintainer mid-session or blocks every integration in the repo.
import { describe, expect, it } from "vitest";
import { judgeRefUpdate, refusalMessage } from "./guard-policy.mjs";

const ROOT = "/repo";
const at = (over: Record<string, unknown> = {}) => ({
  ref: "refs/heads/main",
  viaPromote: false,
  cwd: ROOT,
  repoRoot: ROOT,
  ...over,
});

describe("judgeRefUpdate", () => {
  /// THE EVENT THIS EXISTS FOR: on 2026-08-29 refs/heads/main moved at 11:48 by fast-forward and
  /// rebuilt the app under the maintainer mid-session.
  it("refuses moving the app ref at the root outside promote", () => {
    expect(judgeRefUpdate(at())).toEqual({ allow: false, reason: "app-ref-moved-outside-promote" });
  });

  it("allows it through promote, the sanctioned path", () => {
    expect(judgeRefUpdate(at({ viaPromote: true })).allow).toBe(true);
  });

  /// Narrow on purpose: a guard that blocks ordinary work becomes a guard people disable.
  it("never touches develop, work branches, tags or stashes", () => {
    for (const ref of ["refs/heads/develop", "refs/heads/my-fix", "refs/tags/v1", "refs/stash"]) {
      expect(judgeRefUpdate(at({ ref })).allow).toBe(true);
    }
  });

  /// Only the ROOT is the running app. Another worktree may hold `main` transiently.
  it("allows an app-ref move from a worktree that is not the app tree", () => {
    expect(judgeRefUpdate(at({ cwd: "/repo/wt-x" })).allow).toBe(true);
  });

  it("is inert on a malformed update rather than blocking everything", () => {
    expect(judgeRefUpdate(undefined as never).allow).toBe(true);
    expect(judgeRefUpdate({ ref: "" } as never).allow).toBe(true);
  });

  /// A refusal that does not say the alternative just gets worked around.
  it("names both the integration path and the promote path when it refuses", () => {
    const m = refusalMessage("refs/heads/main");
    expect(m).toContain("wt-integrate");
    expect(m).toContain("npm run promote");
  });
});
