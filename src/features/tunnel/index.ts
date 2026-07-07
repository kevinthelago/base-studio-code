// Tunnel feature — public API (#1309): the optional mobile relay bridge (Noise-IK E2E over a
// zero-knowledge Cloudflare relay). The Tunnel settings page, the always-on sync/automation/coord
// hooks the app mounts, and the protocol/client live here.
export { TunnelSettings } from "./Tunnel";
export { useTunnelSync } from "./useTunnelSync";
export { useTunnelAutomations } from "./lib/useTunnelAutomations";
export { useTunnelHookTelemetry } from "./lib/useTunnelHookTelemetry";
export { useTunnelCoordControl } from "./lib/useTunnelCoordControl";

// #1545: public API for cross-feature consumers (app/console, planner, components).
export type { PlanMessage, SessionMeta, PaneDescriptor, PaneKind } from "./lib/tunnel";
export { TUNNEL_PROTOCOL_VERSION } from "./lib/tunnel";
export {
  tunnelStatus, tunnelSetSessions, tunnelSetPlanState,
  tunnelEmitPlanState, tunnelEmitPlanStatus, tunnelEmitPlanEvent,
  tunnelSetStoreState, STORE_DOMAINS,
} from "./lib/tunnelClient";
export type { StoreDomain } from "./lib/tunnelClient";
