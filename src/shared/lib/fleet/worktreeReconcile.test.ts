// #3614 — the boot reconciliation that heals the fleet split-brain: a worker whose worktree was
// reclaimed by the boot-GC is marked ENDED (done) rather than relaunched into a deleted directory.
import { describe, it, expect, vi } from "vitest";
import { worktreeChecks, reclaimedWorkerEnd, reconcileMissingWorktrees } from "./worktreeReconcile";

describe("worktreeChecks — which fleet workers to probe (#3614)", () => {
  const streams = {
    "p:a": { id: "a" },
    "p:b": { id: "b" },
    "p:c": { id: "c" },
    "p:d": { id: "d" },
  };
  const cwds = { "p:a": "/wt/a", "p:b": "/wt/b", "p:c": "/wt/c" }; // d has no cwd

  it("includes worker panes with a cwd; excludes ended, disabled, and cwd-less", () => {
    const checks = worktreeChecks(streams, { "p:b": {} }, { "p:c": true }, cwds);
    expect(checks.map((c) => c.paneId).sort()).toEqual(["p:a"]);
    expect(checks[0]).toEqual({ paneId: "p:a", cwd: "/wt/a", streamId: "a" });
  });

  it("returns nothing when there are no fleet panes", () => {
    expect(worktreeChecks({}, {}, {}, {})).toEqual([]);
  });
});

describe("reclaimedWorkerEnd", () => {
  it("marks the worker done (GC only reclaims merged+clean = work landed)", () => {
    expect(reclaimedWorkerEnd("auth", 123)).toEqual({
      state: "done",
      streamId: "auth",
      summary: expect.stringContaining("worktree reclaimed"),
      at: 123,
    });
  });
});

describe("reconcileMissingWorktrees — the heal (#3614)", () => {
  const checks = [
    { paneId: "p:a", cwd: "/wt/a", streamId: "a" }, // gone → end
    { paneId: "p:b", cwd: "/wt/b", streamId: "b" }, // exists → leave
    { paneId: "p:c", cwd: "/wt/c", streamId: "c" }, // gone but already ended → skip
  ];
  const exists = (cwd: string) => Promise.resolve(cwd === "/wt/b"); // only b's worktree survives

  it("ends only the workers whose worktree is gone and not already ended", async () => {
    const marked: Array<{ paneId: string; state: string }> = [];
    const ended = await reconcileMissingWorktrees(
      checks,
      exists,
      (paneId) => paneId === "p:c",                                   // c already ended
      (paneId, info) => marked.push({ paneId, state: info.state }),
      () => 999,
    );
    expect(ended).toEqual(["p:a"]);
    expect(marked).toEqual([{ paneId: "p:a", state: "done" }]);
  });

  it("a probe that reports everything present ends nothing (never touches live workers)", async () => {
    const mark = vi.fn();
    const ended = await reconcileMissingWorktrees(checks, () => Promise.resolve(true), () => false, mark, () => 0);
    expect(ended).toEqual([]);
    expect(mark).not.toHaveBeenCalled();
  });
});
