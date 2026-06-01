import { describe, it, expect } from "vitest";
import { flowPermissionRules, PUSH_WRITE_RULES } from "../screens/projects/flowPermissions";
import { DEFAULT_FLOW, type AgentFlow } from "../screens/projects/agentFlow";

const flow = (p: Partial<AgentFlow>): AgentFlow => ({ ...DEFAULT_FLOW, ...p });

describe("flowPermissionRules", () => {
  it("auto-pr contributes no rules (broad Bash allow permits push + PR)", () => {
    expect(flowPermissionRules(flow({ push: "auto-pr" }))).toEqual({ askToolRules: [], denyToolRules: [] });
  });

  it("push-confirm + hard gate asks before push and PR", () => {
    const r = flowPermissionRules(flow({ push: "push-confirm", gate: "hard" }));
    expect(r.askToolRules).toEqual([...PUSH_WRITE_RULES]);
    expect(r.denyToolRules).toEqual([]);
  });

  it("push-confirm + soft gate contributes no enforced rules (kickoff asks)", () => {
    expect(flowPermissionRules(flow({ push: "push-confirm", gate: "soft" }))).toEqual({ askToolRules: [], denyToolRules: [] });
  });

  it("commit-only denies push and PR but leaves commits local", () => {
    const r = flowPermissionRules(flow({ push: "commit-only" }));
    expect(r.denyToolRules).toEqual([...PUSH_WRITE_RULES]);
    expect(r.askToolRules).toEqual([]);
  });

  it("none denies push and PR (no GitHub propagation)", () => {
    expect(flowPermissionRules(flow({ push: "none" })).denyToolRules).toEqual([...PUSH_WRITE_RULES]);
  });

  it("undefined flow resolves to DEFAULT_FLOW (auto-pr) — no rules", () => {
    expect(flowPermissionRules(undefined)).toEqual({ askToolRules: [], denyToolRules: [] });
  });

  it("gate is ignored unless push is push-confirm", () => {
    // a hard gate on an auto-pr flow must not start blocking/asking
    expect(flowPermissionRules(flow({ push: "auto-pr", gate: "hard" }))).toEqual({ askToolRules: [], denyToolRules: [] });
  });
});

import { flowGrantedPushCommands } from "../screens/projects/flowPermissions";

describe("flowGrantedPushCommands — reconcile with the role gate (#304)", () => {
  it("auto-pr grants git push + gh pr create (lifts the worker role's gh-pr deny)", () => {
    expect(flowGrantedPushCommands(flow({ push: "auto-pr" }))).toEqual(["git push", "gh pr create"]);
  });

  it("push-confirm also grants them (the flow's ask tier then prompts)", () => {
    expect(flowGrantedPushCommands(flow({ push: "push-confirm", gate: "hard" }))).toEqual(["git push", "gh pr create"]);
  });

  it("commit-only and none grant nothing — the role's denies hold", () => {
    expect(flowGrantedPushCommands(flow({ push: "commit-only" }))).toEqual([]);
    expect(flowGrantedPushCommands(flow({ push: "none" }))).toEqual([]);
  });

  it("never grants gh pr merge or other role-denied writes", () => {
    for (const p of ["auto-pr", "push-confirm", "commit-only", "none"] as const) {
      const g = flowGrantedPushCommands(flow({ push: p }));
      expect(g).not.toContain("gh pr merge");
      expect(g).not.toContain("gh repo delete");
    }
  });
});
