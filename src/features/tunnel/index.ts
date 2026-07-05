// Tunnel feature — public API (#1309): the optional mobile relay bridge (Noise-IK E2E over a
// zero-knowledge Cloudflare relay). The Tunnel settings page, the always-on sync/automation/coord
// hooks the app mounts, and the protocol/client live here.
export { TunnelSettings } from "./Tunnel";
export { useTunnelSync } from "./useTunnelSync";
export { useTunnelAutomations } from "./lib/useTunnelAutomations";
export { useTunnelHookTelemetry } from "./lib/useTunnelHookTelemetry";
export { useTunnelCoordControl } from "./lib/useTunnelCoordControl";

// #1545: public API for cross-feature consumers (app/console, planner).
export type { PlanMessage, SessionMeta } from "./lib/tunnel";
export {
  tunnelStatus, tunnelSetSessions, tunnelSetPlanState,
  tunnelEmitPlanState, tunnelEmitPlanStatus, tunnelEmitPlanEvent,
} from "./lib/tunnelClient";
