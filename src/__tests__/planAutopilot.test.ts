import { describe, it, expect } from "vitest";
import {
  decideAutopilotAction, buildUserSimPrompt, staticReply, autopilotProgress,
  type AutopilotContext,
} from "../screens/planner/session/planAutopilot";
import type { Phase } from "../screens/planner/stages/focusedPlan";

const ctx = (over: Partial<AutopilotContext> = {}): AutopilotContext => ({
  planReady: false, published: false, confirmKeys: [], plannerAwaiting: false,
  iteration: 0, maxIterations: 100, idleStreak: 0, maxIdle: 5, autoPublish: true, ...over,
});

const phase = (status: Phase["status"]): Phase =>
  ({ key: "k", name: "K", glyph: "•", blurb: "", gate: "", index: 0, total: 1, status, fraction: 0 });

describe("decideAutopilotAction (#682)", () => {
  it("publishes when the plan is ready + unpublished (harness), then is done", () => {
    expect(decideAutopilotAction(ctx({ planReady: true }))).toEqual({ kind: "publish" });
    expect(decideAutopilotAction(ctx({ planReady: true, published: true }))).toEqual({ kind: "done" });
  });

  it("the feature (autoPublish=false) stops at a publishable plan — done, never publish (#682)", () => {
    expect(decideAutopilotAction(ctx({ planReady: true, autoPublish: false }))).toEqual({ kind: "done" });
  });

  it("while the planner waits: confirms a ready stage, else replies", () => {
    expect(decideAutopilotAction(ctx({ plannerAwaiting: true, confirmKeys: ["goal", "scope"] })))
      .toEqual({ kind: "confirm", keys: ["goal", "scope"] });
    expect(decideAutopilotAction(ctx({ plannerAwaiting: true, confirmKeys: [] })))
      .toEqual({ kind: "reply" });
  });

  it("waits while the planner is still working", () => {
    expect(decideAutopilotAction(ctx({ plannerAwaiting: false }))).toEqual({ kind: "wait" });
  });

  it("stalls on the iteration cap and on a no-progress idle streak", () => {
    expect(decideAutopilotAction(ctx({ iteration: 100, maxIterations: 100 })).kind).toBe("stall");
    expect(decideAutopilotAction(ctx({ plannerAwaiting: false, idleStreak: 5, maxIdle: 5 })).kind).toBe("stall");
  });

  it("idle-stall fires even while the planner is awaiting (the `none` no-response case, #682)", () => {
    expect(decideAutopilotAction(ctx({ plannerAwaiting: true, idleStreak: 6, maxIdle: 6 })).kind).toBe("stall");
  });

  it("the cap takes precedence even when the plan is ready", () => {
    expect(decideAutopilotAction(ctx({ planReady: true, iteration: 100, maxIterations: 100 })).kind).toBe("stall");
  });
});

describe("buildUserSimPrompt (#682)", () => {
  it("frames a decisive product owner and includes the pitch + planner output", () => {
    const { system, user } = buildUserSimPrompt("Build a settlement webhooks API", "What's the primary goal?");
    expect(system.toLowerCase()).toContain("product owner");
    expect(system.toLowerCase()).toMatch(/never ask questions back|don't hedge/);
    expect(user).toContain("Build a settlement webhooks API");
    expect(user).toContain("What's the primary goal?");
  });
});

describe("staticReply (#682 strategies)", () => {
  it("none sends nothing; random/scripted produce a reply; llm defers to the runner", () => {
    expect(staticReply("none", 0)).toBeNull();
    expect(staticReply("llm", 0)).toBeNull();
    expect(typeof staticReply("scripted", 0)).toBe("string");
    expect(typeof staticReply("random", 3)).toBe("string");
    expect(staticReply("random", 3)).toBe(staticReply("random", 3)); // deterministic by seed
  });
});

describe("autopilotProgress (#682)", () => {
  it("counts complete + banked-ahead phases as done", () => {
    const p = [phase("complete"), phase("ahead"), phase("active"), phase("upcoming")];
    expect(autopilotProgress(p)).toEqual({ done: 2, total: 4, fraction: 0.5 });
    expect(autopilotProgress([])).toEqual({ done: 0, total: 0, fraction: 0 });
  });
});
