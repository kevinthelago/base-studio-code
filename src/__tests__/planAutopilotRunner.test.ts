import { describe, it, expect, vi } from "vitest";
import {
  autopilotTick, initRunState, MAX_ITERATIONS,
  type AutopilotDeps, type AutopilotSnapshot, type AutopilotLogEntry,
} from "../screens/planner/planAutopilotRunner";

const snap = (over: Partial<AutopilotSnapshot> = {}): AutopilotSnapshot => ({
  planReady: false, confirmKeys: [], plannerAwaiting: false, working: false, autoPublish: true,
  progress: { done: 0, total: 5, fraction: 0 }, ...over,
});

function mkDeps(snapshot: AutopilotSnapshot, over: Partial<AutopilotDeps> = {}) {
  const log: AutopilotLogEntry[] = [];
  const deps: AutopilotDeps = {
    pitch: "Build a thing",
    strategy: "llm",
    snapshot: () => snapshot,
    pendingOutput: () => "what's the goal?",
    userSim: vi.fn(async () => "the goal is X"),
    sendReply: vi.fn(),
    confirm: vi.fn(),
    mockPublish: vi.fn(),
    log: (e) => log.push(e),
    ...over,
  };
  return { deps, log };
}

describe("autopilotTick (#682, Phase 1b)", () => {
  it("replies via the user-sim when the planner is awaiting + the stage isn't ready", async () => {
    const { deps } = mkDeps(snap({ plannerAwaiting: true }));
    const next = await autopilotTick(initRunState(), deps);
    expect(deps.userSim).toHaveBeenCalledOnce();
    expect(deps.sendReply).toHaveBeenCalledWith("the goal is X");
    expect(next.iteration).toBe(1);
    expect(next.idleStreak).toBe(0);
  });

  it("confirms a ready stage instead of replying", async () => {
    const { deps } = mkDeps(snap({ plannerAwaiting: true, confirmKeys: ["goal", "scope"] }));
    await autopilotTick(initRunState(), deps);
    expect(deps.confirm).toHaveBeenCalledWith(["goal", "scope"]);
    expect(deps.sendReply).not.toHaveBeenCalled();
  });

  it("mock-publishes when the plan is ready (never a real publish), then finishes done", async () => {
    const { deps } = mkDeps(snap({ planReady: true }));
    const afterPublish = await autopilotTick(initRunState(), deps);
    expect(deps.mockPublish).toHaveBeenCalledOnce();
    expect(afterPublish.published).toBe(true);
    expect(afterPublish.finished).toBe(false);
    const done = await autopilotTick(afterPublish, deps);
    expect(done.finished).toBe(true);
    expect(done.result?.completed).toBe(true);
  });

  it("the feature (autoPublish=false) finishes done at a publishable plan — never publishes (#682)", async () => {
    const { deps } = mkDeps(snap({ planReady: true, autoPublish: false }));
    const next = await autopilotTick(initRunState(), deps);
    expect(deps.mockPublish).not.toHaveBeenCalled();
    expect(next.finished).toBe(true);
    expect(next.result?.completed).toBe(true);
    expect(next.result?.published).toBe(false);
  });

  it("counts idle ticks while the planner works, and stalls past the idle cap", async () => {
    const { deps } = mkDeps(snap({ plannerAwaiting: false }));
    let s = initRunState();
    for (let i = 0; i < 6; i++) s = await autopilotTick(s, deps);
    expect(s.idleStreak).toBe(6);
    const stalled = await autopilotTick(s, deps);
    expect(stalled.finished).toBe(true);
    expect(stalled.result?.completed).toBe(false);
    expect(stalled.result?.stalledReason).toMatch(/no progress/);
  });

  it("stalls at the iteration cap", async () => {
    const { deps } = mkDeps(snap({ plannerAwaiting: true }));
    const s = { ...initRunState(), iteration: MAX_ITERATIONS };
    const stalled = await autopilotTick(s, deps);
    expect(stalled.finished).toBe(true);
    expect(stalled.result?.stalledReason).toMatch(/cap/);
  });

  it("a scripted strategy sends a canned reply without calling Claude (#682, Phase 2)", async () => {
    const { deps } = mkDeps(snap({ plannerAwaiting: true }), { strategy: "scripted" });
    await autopilotTick(initRunState(), deps);
    expect(deps.userSim).not.toHaveBeenCalled();
    expect(deps.sendReply).toHaveBeenCalledOnce();
  });

  it("the `none` strategy sends nothing and climbs toward a stall", async () => {
    const { deps } = mkDeps(snap({ plannerAwaiting: true }), { strategy: "none" });
    const next = await autopilotTick(initRunState(), deps);
    expect(deps.sendReply).not.toHaveBeenCalled();
    expect(next.idleStreak).toBe(1);
  });

  it("active planner output keeps the idle streak from climbing (working = progress)", async () => {
    const { deps } = mkDeps(snap({ working: true }));
    let s = { ...initRunState(), idleStreak: 4 };
    for (let i = 0; i < 5; i++) s = await autopilotTick(s, deps);
    expect(s.idleStreak).toBe(1); // reset each working tick → never climbs to a stall
    expect(s.finished).toBe(false);
  });

  it("is a no-op once finished", async () => {
    const { deps } = mkDeps(snap({ planReady: true }));
    const done = { ...initRunState(), finished: true };
    expect(await autopilotTick(done, deps)).toBe(done);
    expect(deps.mockPublish).not.toHaveBeenCalled();
  });
});
