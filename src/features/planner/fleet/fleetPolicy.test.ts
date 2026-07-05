import { describe, it, expect } from "vitest";
import { resolveStreamFlow, resolveStreamProfile } from "./fleetPolicy";
import { DEFAULT_FLOW, type AgentFlow } from "./agentFlow";

const STREAM_FLOW: AgentFlow = { autonomy: "confirm", push: "commit-only", trigger: "on-green", gate: "soft" };
const POLICY_FLOW: AgentFlow = { autonomy: "checkpoint", push: "push-confirm", trigger: "per-stage", gate: "hard" };

describe("resolveStreamFlow (#1854 Phase b)", () => {
  it("returns undefined when neither the stream nor the policy declares a flow (byte-identical default)", () => {
    // Undefined ⇒ the launch path applies DEFAULT_FLOW downstream — parity with pre-policy behavior.
    expect(resolveStreamFlow(undefined, undefined)).toBeUndefined();
  });

  it("uses the blueprint policy flow when the stream declares none", () => {
    expect(resolveStreamFlow(undefined, POLICY_FLOW)).toBe(POLICY_FLOW);
  });

  it("the stream's own flow WINS over the blueprint policy", () => {
    expect(resolveStreamFlow(STREAM_FLOW, POLICY_FLOW)).toBe(STREAM_FLOW);
  });

  it("passes the stream flow through when there is no policy", () => {
    expect(resolveStreamFlow(STREAM_FLOW, undefined)).toBe(STREAM_FLOW);
  });

  it("never fabricates DEFAULT_FLOW itself (resolution stays undefined, not defaulted)", () => {
    expect(resolveStreamFlow(undefined, undefined)).not.toEqual(DEFAULT_FLOW);
  });
});

describe("resolveStreamProfile (#1854 Phase b)", () => {
  const ROLE_DEFAULT = "pf_worker";

  it("falls back to the role default when neither the stream nor the policy sets a profile", () => {
    expect(resolveStreamProfile(undefined, undefined, ROLE_DEFAULT)).toBe(ROLE_DEFAULT);
  });

  it("uses the blueprint policy profile when the stream pins none", () => {
    expect(resolveStreamProfile(undefined, "pf_locked", ROLE_DEFAULT)).toBe("pf_locked");
  });

  it("the stream's own pinned profile WINS over the blueprint policy and the role default", () => {
    expect(resolveStreamProfile("pf_pinned", "pf_locked", ROLE_DEFAULT)).toBe("pf_pinned");
  });

  it("the caller can opt a stream (e.g. the director) OUT of the policy by passing undefined policy", () => {
    // fleetStartProject passes policyProfile=undefined for the director → always the role default.
    expect(resolveStreamProfile(undefined, undefined, "pf_director_readonly")).toBe("pf_director_readonly");
  });
});
