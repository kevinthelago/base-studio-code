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
