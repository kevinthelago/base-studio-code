// impl-store drift was permanently blind off Windows (bsc-request-134): the binary resolver hardcoded
// `target/{release,debug}/bsc.exe`, so on Linux/macOS every candidate ENOENTs before the drift check
// ever runs. These pin the two decisions that fix depends on — which roots get searched, and how a
// resolution failure is reported — without needing a real `bsc` binary or a real seed file.
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { bscRoots, resolveBsc } from "./impl-store-drift.mjs";

const ok = (stdout = "bsc 0.1.0\n  built 2026-08-20 01:19:35 UTC") => () => ({ status: 0, stdout });

describe("impl-store-drift: bscRoots", () => {
  it("searches the repo AND its parent, so a worktree with no build falls back to the main repo", () => {
    const roots = bscRoots("/repo/.claude/worktrees/134-fix");
    expect(roots).toEqual(["/repo/.claude/worktrees/134-fix", join("/repo/.claude/worktrees/134-fix", "..")]);
  });
});

describe("impl-store-drift: resolveBsc", () => {
  it("finds a platform-appropriate binary — no `.exe` assumed off Windows", () => {
    // This is the exact bug: the old resolver only ever tried names ending `.exe`, so a real `bsc` on
    // Linux/macOS was invisible no matter how many roots were searched.
    const got = resolveBsc(["/repo"], "/home", {
      statSize: (p: string) => (p === "/repo/target/debug/bsc" ? 69_000_000 : null),
      run: ok(),
    });
    expect(got.ok).toBe(true);
    expect(got.path).toBe("/repo/target/debug/bsc");
  });

  it("falls through every root before giving up", () => {
    const got = resolveBsc(["/worktree", "/repo"], "/home", {
      statSize: (p: string) => (p === "/repo/target/debug/bsc" ? 69_000_000 : null),
      run: ok(),
    });
    expect(got.ok).toBe(true);
    expect(got.path).toBe("/repo/target/debug/bsc");
  });

  it("reports WHICH candidates were tried and WHY, rather than a bare null", () => {
    // The original bug report ("could not reach the impl store") was already caught once for being a
    // lying diagnostic when it gave no reason. The fix must not regress that: a failed resolution still
    // names every path it tried.
    const got = resolveBsc(["/repo"], "/home", { statSize: () => null, run: ok() });
    expect(got.ok).toBe(false);
    expect(got.detail).toContain("/repo/target/debug/bsc");
    expect(got.detail).toContain("/repo/target/release/bsc");
    expect(got.detail).toContain("/home/.base-studio-code/bin/bsc");
  });

  it("skips a zero-byte binary instead of reporting a false pass", () => {
    // A broken/interrupted link leaves a zero-length file; bash execs it as an empty script that exits 0
    // printing nothing. `resolveBsc` must not hand that path back as usable.
    const got = resolveBsc(["/repo"], "/home", {
      statSize: (p: string) => (p === "/repo/target/debug/bsc" ? 0 : p === "/repo/target/release/bsc" ? 69_000_000 : null),
      run: ok(),
    });
    expect(got.ok).toBe(true);
    expect(got.path).toBe("/repo/target/release/bsc");
  });
});
