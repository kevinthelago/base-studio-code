import { describe, it, expect } from "vitest";
import { flowKickoffText } from "../screens/projects/flowKickoff";
import { DEFAULT_FLOW, type AgentFlow } from "../screens/projects/agentFlow";

const flow = (p: Partial<AgentFlow>): AgentFlow => ({ ...DEFAULT_FLOW, ...p });

describe("flowKickoffText", () => {
  it("default flow (continuous + auto-pr) tells the agent to push + open a PR", () => {
    const k = flowKickoffText(undefined, "auth-ui");
    expect(k.autonomy).toMatch(/do not stop to ask/);
    // #382: continuous autonomy no longer references the old PR-merge model.
    expect(k.autonomy).not.toMatch(/the director reviews and merges/);
    expect(k.autonomy).toMatch(/do not end your turn while any remain unintegrated/);
    expect(k.push).toMatch(/push it, and open a PR to develop/);
    expect(k.push).toContain("auth-ui");
  });

  it("hard push-confirm tells the agent to STOP and wait for approval", () => {
    const k = flowKickoffText(flow({ push: "push-confirm", gate: "hard" }), "api");
    expect(k.push).toMatch(/STOP and ask the user before pushing/);
    expect(k.push).toMatch(/prompt for approval/);
  });

  it("soft push-confirm pauses but does not mention the approval prompt", () => {
    const k = flowKickoffText(flow({ push: "push-confirm", gate: "soft" }), "api");
    expect(k.push).toMatch(/pause and ask the user/);
    expect(k.push).not.toMatch(/prompt for approval/);
  });

  it("commit-only forbids pushing", () => {
    expect(flowKickoffText(flow({ push: "commit-only" }), "api").push).toMatch(/do not push/);
  });

  it("none is read-only — no commit/push/PR", () => {
    expect(flowKickoffText(flow({ push: "none" }), "api").push).toMatch(/read-only role: do not commit, push, or open PRs/);
  });

  it("confirm autonomy asks before non-trivial decisions", () => {
    expect(flowKickoffText(flow({ autonomy: "confirm" }), "api").autonomy).toMatch(/pause and ask the user to confirm/);
    expect(flowKickoffText(flow({ autonomy: "confirm" }), "api").autonomy).toMatch(/bsc-wait/);
  });

  it("checkpoint autonomy pauses at stage/PR boundaries via bsc-checkpoint", () => {
    expect(flowKickoffText(flow({ autonomy: "checkpoint" }), "api").autonomy).toMatch(/bsc-checkpoint.*wait to be resumed/);
    expect(flowKickoffText(flow({ autonomy: "checkpoint" }), "api").autonomy).toMatch(/bsc-wait/);
  });

  it("self-merge tells the agent to rebase + push develop, land via bsc-landed, and not open a PR", () => {
    const k = flowKickoffText(flow({ push: "self-merge" }), "api");
    expect(k.push).toMatch(/rebase/i);
    expect(k.push).toMatch(/develop/);
    expect(k.push).toMatch(/push develop/i);
    expect(k.push).toMatch(/bsc-landed/);
    // The auto-pr instruction "open a PR to develop" must not appear (self-merge says do NOT open a PR).
    expect(k.push).not.toMatch(/open a PR to develop/i);
    expect(k.push).not.toMatch(/pull request/i);
    expect(k.push).toMatch(/do NOT open a PR/);
    // #382: self-merge workers must not stop while owned issues remain.
    expect(k.push).toMatch(/do not stop/i);
  });

  it("the trigger phrase varies the push sentence", () => {
    expect(flowKickoffText(flow({ trigger: "per-stage" }), "x").push).toMatch(/at each pipeline stage boundary/);
    expect(flowKickoffText(flow({ trigger: "on-green" }), "x").push).toMatch(/as soon as the checks pass/);
  });
});
