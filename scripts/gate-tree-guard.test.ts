// Unit tests for the gate's dev-tree guard (#a-corrupt-build-artifact-has-no-recovery-path).
// Pure: no filesystem, no sockets, no running app.
import { describe, expect, it } from "vitest";
import { decideGateTree, devPortFrom } from "./gate-tree-guard.mjs";

describe("decideGateTree", () => {
  // The normal case, and the one that must stay frictionless: a worktree (or a quiet main tree)
  // with no dev server. Refusing here would obstruct every gate the fleet runs.
  it("allows a tree with no dev server, silently", () => {
    const v = decideGateTree({ isMainWorktree: true, devServerUp: false, override: false });
    expect(v.allow).toBe(true);
    expect(v.reason).toBe("");
  });

  // THE BUG THIS TEST EXISTS FOR, caught by running the guard against the live app rather than only
  // against fixtures. The dev-server port is MACHINE-GLOBAL: a worktree's gate sees the main tree's
  // 1420 just as plainly as the main tree does. Keying on the port alone would have refused every
  // gate in every worktree — i.e. blocked the whole fleet — to protect one tree.
  it("does NOT refuse a linked worktree, even while a dev server is live on the shared port", () => {
    const v = decideGateTree({ isMainWorktree: false, devServerUp: true, override: false });
    expect(v.allow).toBe(true);
    expect(v.reason).toBe("");
  });

  // THE CONDITION BEING PREVENTED: `tauri dev` owns this tree's target/, and a second cargo here is
  // what produced a 0-byte `bsc` and a 40-minute app link failure on 2026-08-24.
  it("refuses a tree whose dev server is live, and says where to go instead", () => {
    const v = decideGateTree({ isMainWorktree: true, devServerUp: true, override: false });
    expect(v.allow).toBe(false);
    expect(v.reason).toMatch(/tauri dev/);
    expect(v.reason).toMatch(/git worktree add/);
    // The escape hatch must be NAMED in the refusal — a guard you cannot get past is a guard people
    // work around by deleting it.
    expect(v.reason).toMatch(/BSC_GATE_ALLOW_DEV_TREE/);
  });

  it("honours the override but still says the risk out loud", () => {
    const v = decideGateTree({ isMainWorktree: true, devServerUp: true, override: true });
    expect(v.allow).toBe(true);
    expect(v.reason).toMatch(/BSC_GATE_ALLOW_DEV_TREE/);
    expect(v.reason).not.toBe("");
  });
});

describe("devPortFrom", () => {
  it("reads the port out of devUrl", () => {
    expect(devPortFrom({ build: { devUrl: "http://127.0.0.1:1420" } })).toBe(1420);
    expect(devPortFrom({ build: { devUrl: "http://localhost:5173/" } })).toBe(5173);
  });

  // A guard that cannot read its own config must NOT start refusing gates — the caller treats null
  // as "no dev server". Failing closed on our own uncertainty would block the fleet the first time
  // this config key moved.
  it("returns null rather than guessing when there is no port", () => {
    expect(devPortFrom({})).toBeNull();
    expect(devPortFrom({ build: {} })).toBeNull();
    expect(devPortFrom({ build: { devUrl: "" } })).toBeNull();
    expect(devPortFrom(null as unknown as object)).toBeNull();
  });
});
