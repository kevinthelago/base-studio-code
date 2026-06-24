import { describe, it, expect } from "vitest";
import { whenExpr, automationToFrame, planArm } from "./automationControl";
import type { Automation } from "../automations/scheduler";

function auto(over: Partial<Automation> = {}): Automation {
  return {
    id: "a1", name: "Nightly tests", armed: false,
    when: { kind: "cron", expr: "0 2 * * *" },
    targetTab: "build", targetPaneIdx: 0,
    action: "command", command: "npm test",
    lastRunAt: null, nextRunAt: null, runs: [],
    ...over,
  };
}

describe("whenExpr (#937)", () => {
  it("returns the cron expression for a cron trigger", () => {
    expect(whenExpr({ kind: "cron", expr: "*/5 * * * *" })).toBe("*/5 * * * *");
  });
  it("formats a simple trigger, omitting the time for a per-minute one", () => {
    expect(whenExpr({ kind: "simple", every: "day", at: "09:00" })).toBe("every day · 09:00");
    expect(whenExpr({ kind: "simple", every: "minute", at: "" })).toBe("every minute");
  });
});

describe("automationToFrame (#937)", () => {
  it("projects the phone-visible fields, lastStatus from the newest run", () => {
    const f = automationToFrame(auto({
      armed: true, lastRunAt: 5, nextRunAt: 10,
      runs: [{ at: 5, status: "ok", note: "" }, { at: 1, status: "fail", note: "" }],
    }));
    expect(f).toEqual({
      id: "a1", name: "Nightly tests", armed: true, whenExpr: "0 2 * * *",
      lastRunAt: 5, nextRunAt: 10, lastStatus: "ok",
    });
  });
  it("reports a null lastStatus with no runs", () => {
    expect(automationToFrame(auto()).lastStatus).toBeNull();
  });
});

describe("planArm (#937)", () => {
  it("rejects an unknown automation", () => {
    expect(planArm(undefined, "ghost", true)).toEqual({ ok: false, id: "ghost", name: "ghost", error: "unknown automation" });
  });
  it("rejects arming a cron automation whose expression is invalid", () => {
    const d = planArm(auto({ when: { kind: "cron", expr: "not a cron" } }), "a1", true);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.error).toMatch(/invalid cron/i);
  });
  it("allows arming a valid cron automation", () => {
    expect(planArm(auto(), "a1", true)).toEqual({ ok: true, id: "a1", armed: true });
  });
  it("allows disarming even when the cron is invalid (nothing will run)", () => {
    expect(planArm(auto({ when: { kind: "cron", expr: "bad" } }), "a1", false)).toEqual({ ok: true, id: "a1", armed: false });
  });
  it("allows arming a simple trigger (no cron to validate)", () => {
    expect(planArm(auto({ when: { kind: "simple", every: "day", at: "08:00" } }), "a1", true)).toEqual({ ok: true, id: "a1", armed: true });
  });
});
