// Tunnel feature — public API (#1309): the optional mobile relay bridge (Noise-IK E2E over a
// zero-knowledge Cloudflare relay). The Tunnel settings page, the always-on sync/automation/coord
// hooks the app mounts, and the protocol/client live here.
export { TunnelSettings } from "./Tunnel";
export { useTunnelSync } from "./useTunnelSync";
export { useStoreProjector } from "./useStoreProjector";
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

// #2498: the store projector + alert pipeline. The planner publishes its stage/gate board as
// the `plan` domain and contributes gate-ready / planner-waiting alerts through these.
export { publishTunnelDomain } from "./lib/tunnelDomains";
export { recordTunnelAlerts } from "./lib/alertHub";
export { gateReadyAlert, plannerWaitingAlert } from "./lib/alerts";
export type { AlertEvent, AlertKind } from "./lib/alerts";
