// Blueprint fleet-policy resolution (#1854 Phase b) — the pure resolvers that compose a stream's
// effective profile + flow from three layers, in precedence order:
//
//   1. the stream's OWN declared value      (planner-GENERATED, per-project — always wins)
//   2. the seeding blueprint's FleetPolicy   (the DEFAULT this project type declares)
//   3. the hard launch-time default          (role default profile / DEFAULT_FLOW)
//
// This is the "planner reads defaults from the blueprint" wiring: the blueprint carries the
// recipe/policy, the planner instantiates concrete per-stream config, and a stream's own choice
// still overrides. When the blueprint declares no policy, every resolver reduces to today's
// behavior byte-for-byte (see the fleetStartProject launch path).
//
// Pure (no React/Tauri) so it's unit-testable and shared by the launch path.

import type { AgentFlow } from "./agentFlow";

/**
 * The effective FLOW for a stream: the stream's own `flow` wins; else the blueprint policy's flow
 * default; else `undefined` — deliberately NOT {@link DEFAULT_FLOW}, so the launch path keeps its
 * "absent ⇒ apply DEFAULT_FLOW downstream" semantics. Returning `undefined` when neither layer
 * sets a flow makes the resolution byte-identical to the pre-policy behavior.
 *
 * @param streamFlow the stream's own declared flow, or `undefined`
 * @param policyFlow the seeding blueprint's `fleetPolicy.flow` default, or `undefined`
 */
export function resolveStreamFlow(
  streamFlow: AgentFlow | undefined,
  policyFlow: AgentFlow | undefined,
): AgentFlow | undefined {
  return streamFlow ?? policyFlow;
}

/**
 * The effective PROFILE id for a stream: the stream's own pinned `profile` wins; else the blueprint
 * policy's profile default; else the role default. The blueprint only SEEDS the launch default — the
 * role gate (#219) still caps the session at launch (the request-vs-cap posture is Phase c).
 *
 * The caller is responsible for passing `policyProfile: undefined` for the director (the policy is a
 * per-WORKER default), so the director always resolves to its role's read-only review profile.
 *
 * @param streamProfile the stream's own pinned profile id, or `undefined`
 * @param policyProfile the seeding blueprint's `fleetPolicy.profile` default, or `undefined`
 * @param roleDefault   the role's default profile id (the historical fallback)
 */
export function resolveStreamProfile(
  streamProfile: string | undefined,
  policyProfile: string | undefined,
  roleDefault: string,
): string {
  return streamProfile ?? policyProfile ?? roleDefault;
}
