// #3455 — the shared turn-accounting hooks. This set has silently fallen out of a launch path twice
// (fleet #3452, planner #3455); pinning its contents here means any future edit that drops bsc-tokens
// or an event breaks the build, not the cost data three weeks later.
import { describe, it, expect } from "vitest";
import { TURN_ACCOUNTING_HOOKS } from "./turnHooks";

describe("TURN_ACCOUNTING_HOOKS", () => {
  it("records bsc-tokens on BOTH Stop and SubagentStop — the only per-session token source", () => {
    const tokenEvents = TURN_ACCOUNTING_HOOKS.filter((h) => h.command === "bsc-tokens")
      .map((h) => h.event)
      .sort();
    expect(tokenEvents).toEqual(["Stop", "SubagentStop"]);
  });

  it("records bsc-activity run on prompt and idle on both turn-ends (the turn-boundary signal)", () => {
    const byCmd = (cmd: string) => TURN_ACCOUNTING_HOOKS.filter((h) => h.command === cmd).map((h) => h.event);
    expect(byCmd("bsc-activity run")).toEqual(["UserPromptSubmit"]);
    expect(byCmd("bsc-activity idle").sort()).toEqual(["Stop", "SubagentStop"]);
  });

  it("is observability ONLY — carries no gating/permission hook", () => {
    // Guards the scope line: the gating floor (confine/deny/scope/taint/audit/defer) is a per-path
    // policy decision and must NOT ride this constant onto the planner (or anywhere) by accident.
    const commands = TURN_ACCOUNTING_HOOKS.map((h) => h.command);
    for (const gating of ["bsc-confine", "bsc-deny", "bsc-scope", "bsc-taint", "bsc-audit", "bsc-defer"]) {
      expect(commands).not.toContain(gating);
    }
  });

  it("uses an empty matcher (every turn, no tool filter)", () => {
    for (const h of TURN_ACCOUNTING_HOOKS) expect(h.matcher).toBe("");
  });
});
