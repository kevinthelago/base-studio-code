import { describe, it, expect } from "vitest";
import {
  decideAutopilotAction, buildUserSimPrompt, staticReply, autopilotProgress,
  type AutopilotContext,
} from "./planAutopilot";
import type { Stage } from "../stages/focusedPlan";

const ctx = (over: Partial<AutopilotContext> = {}): AutopilotContext => ({
  planReady: false, published: false, confirmKeys: [], plannerAwaiting: false,
  iteration: 0, maxIterations: 100, idleStreak: 0, maxIdle: 5, autoPublish: true, ...over,
});

const stage = (status: Stage["status"]): Stage =>
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

  // #2416: the sim-user prose moved to `@data/planner/autopilot-sim.json` — pin the rendered
  // output byte-identical to the previous TS-authored strings.
  it("renders byte-identical to the pre-@data TS strings (#2416)", () => {
    const { system, user } = buildUserSimPrompt("  Build a settlement webhooks API \n", " What's the primary goal? ");
    expect(system).toBe(
      "You are simulating a PRODUCT OWNER being interviewed by an AI project planner. " +
      "Answer the planner's latest message concretely and decisively in 1–3 sentences, as the " +
      "person who pitched the project. Make reasonable, consistent decisions; never ask " +
      "questions back; don't hedge or stall. When asked to choose or confirm, do so. Stay true " +
      "to the pitch and to your earlier answers.",
    );
    // pitch + planner output are trimmed, exactly as before
    expect(user).toBe(
      "PROJECT PITCH:\nBuild a settlement webhooks API\n\n" +
      "THE PLANNER JUST SAID:\nWhat's the primary goal?\n\n" +
      "Your reply, as the product owner:",
    );
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

  // #2416: the canned replies moved to `@data/planner/autopilot-sim.json` — pin the previous corpus.
  it("scripted + random replies are byte-identical to the pre-@data TS strings (#2416)", () => {
    expect(staticReply("scripted", 0)).toBe("Looks good — proceed.");
    const corpus = [
      "sure, whatever you think is best",
      "yes", "no", "skip that one", "use the defaults",
      "I'm not sure, you decide", "keep it simple", "next",
    ];
    for (let seed = 0; seed < corpus.length; seed++) {
      expect(staticReply("random", seed)).toBe(corpus[seed % corpus.length]);
    }
  });
});

describe("autopilotProgress (#682)", () => {
  it("counts complete + banked-ahead stages as done", () => {
    const p = [stage("complete"), stage("ahead"), stage("active"), stage("upcoming")];
    expect(autopilotProgress(p)).toEqual({ done: 2, total: 4, fraction: 0.5 });
    expect(autopilotProgress([])).toEqual({ done: 0, total: 0, fraction: 0 });
  });
});
