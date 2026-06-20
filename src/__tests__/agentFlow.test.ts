import { describe, it, expect } from "vitest";
import {
  DEFAULT_FLOW, normalizeFlow, flowOrUndefined, resolveFlow,
  FLOW_AUTONOMY, FLOW_PUSH, FLOW_TRIGGER, FLOW_GATE,
} from "../screens/planner/fleet/agentFlow";
import { parseFleetFile } from "../screens/planner/planSections";
import { parseAgentAssigns } from "../screens/planner/planningSession";

describe("agentFlow model", () => {
  it("DEFAULT_FLOW is continuous / auto-pr / per-issue / hard", () => {
    expect(DEFAULT_FLOW).toEqual({ autonomy: "continuous", push: "auto-pr", trigger: "per-issue", gate: "hard" });
  });

  it("every enum value normalizes back to itself", () => {
    for (const a of FLOW_AUTONOMY) expect(normalizeFlow({ autonomy: a }).autonomy).toBe(a);
    for (const p of FLOW_PUSH) expect(normalizeFlow({ push: p }).push).toBe(p);
    for (const t of FLOW_TRIGGER) expect(normalizeFlow({ trigger: t }).trigger).toBe(t);
    for (const g of FLOW_GATE) expect(normalizeFlow({ gate: g }).gate).toBe(g);
  });

  it("normalizeFlow falls back to defaults for missing/invalid/cased input", () => {
    expect(normalizeFlow(null)).toEqual(DEFAULT_FLOW);
    expect(normalizeFlow({ autonomy: "bogus", push: 42 as unknown as string })).toEqual(DEFAULT_FLOW);
    // case-insensitive + trimmed
    expect(normalizeFlow({ autonomy: "  CONFIRM " }).autonomy).toBe("confirm");
  });

  it("flowOrUndefined returns undefined only when no flow field is named", () => {
    expect(flowOrUndefined(null)).toBeUndefined();
    expect(flowOrUndefined({})).toBeUndefined();
    expect(flowOrUndefined({ autonomy: "" })).toBeUndefined();
    expect(flowOrUndefined({ push: "commit-only" })).toEqual({ ...DEFAULT_FLOW, push: "commit-only" });
  });

  it("resolveFlow applies DEFAULT_FLOW when unset", () => {
    expect(resolveFlow(undefined)).toEqual(DEFAULT_FLOW);
    const custom = { ...DEFAULT_FLOW, autonomy: "confirm" as const };
    expect(resolveFlow(custom)).toBe(custom);
  });
});

describe("flow round-trips through both plan channels", () => {
  it("parseAgentAssigns reads autonomy/push/trigger/gate attrs", () => {
    const text = `<agent_assign id="auth-ui" repo="o/r" autonomy="confirm" push="push-confirm" trigger="per-stage" gate="soft" />`;
    const [s] = parseAgentAssigns(text);
    expect(s.flow).toEqual({ autonomy: "confirm", push: "push-confirm", trigger: "per-stage", gate: "soft" });
  });

  it("parseAgentAssigns leaves flow undefined when no flow attrs present (pre-flow plans)", () => {
    const [s] = parseAgentAssigns(`<agent_assign id="x" repo="o/r" owns="src/**" />`);
    expect(s.flow).toBeUndefined();
  });

  it("a single flow attr materializes a full flow with defaults for the rest", () => {
    const [s] = parseAgentAssigns(`<agent_assign id="x" repo="o/r" push="none" />`);
    expect(s.flow).toEqual({ ...DEFAULT_FLOW, push: "none" });
  });

  it("parseFleetFile reads stream.flow (and the previously-dropped profile)", () => {
    const raw = JSON.stringify({
      recommended: 1,
      streams: [{ id: "api", repo: "o/r", profile: "backend", flow: { autonomy: "checkpoint", gate: "soft" } }],
    });
    const plan = parseFleetFile(raw)!;
    expect(plan.streams[0].profile).toBe("backend");
    expect(plan.streams[0].flow).toEqual({ ...DEFAULT_FLOW, autonomy: "checkpoint", gate: "soft" });
  });

  it("parseFleetFile leaves flow undefined when the stream omits it", () => {
    const raw = JSON.stringify({ streams: [{ id: "api", repo: "o/r" }] });
    expect(parseFleetFile(raw)!.streams[0].flow).toBeUndefined();
  });
});
