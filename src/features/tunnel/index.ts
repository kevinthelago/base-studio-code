// The shadow catalogue registers this feature's graph-platform modules by importing
// `./graphPlatform` DIRECTLY and calling its register function (see `shadowPages.ts`). This barrel
// therefore has NO import-time side effect — it is re-exports only, which is what lets it be a
// record rather than a file that must run to be correct.

// Tunnel feature — public API (#1309): the optional mobile relay bridge (Noise-IK E2E over a
// zero-knowledge Cloudflare relay). The Tunnel settings page, the always-on sync/automation/coord
// hooks the app mounts, and the protocol/client live here.
export { TunnelSettings } from "@/features/tunnel/Tunnel";
export { useTunnelSync } from "@/features/tunnel/useTunnelSync";
export { useStoreProjector } from "@/features/tunnel/useStoreProjector";
export { useTunnelAutomations } from "@/features/tunnel/lib/useTunnelAutomations";
export { useTunnelHookTelemetry } from "@/features/tunnel/lib/useTunnelHookTelemetry";
export { useTunnelCoordControl } from "@/features/tunnel/lib/useTunnelCoordControl";

// #1545: public API for cross-feature consumers (app/console, planner, components).
export type { PlanMessage, SessionMeta, PaneDescriptor, PaneKind } from "@/features/tunnel/lib/tunnel";
export { TUNNEL_PROTOCOL_VERSION } from "@/features/tunnel/lib/tunnel";
export {
  tunnelStatus, tunnelSetSessions, tunnelSetPlanState,
  tunnelEmitPlanState, tunnelEmitPlanStatus, tunnelEmitPlanEvent,
  tunnelSetStoreState, STORE_DOMAINS,
} from "@/features/tunnel/lib/tunnelClient";
export type { StoreDomain } from "@/features/tunnel/lib/tunnelClient";

// #2498: the store projector + alert pipeline. The planner publishes its stage/gate board as
// the `plan` domain and contributes gate-ready / planner-waiting alerts through these.
export { publishTunnelDomain } from "@/features/tunnel/lib/tunnelDomains";
export { recordTunnelAlerts } from "@/features/tunnel/lib/alertHub";
export { gateReadyAlert, plannerWaitingAlert, coordAlerts } from "@/features/tunnel/lib/alerts";
export type { AlertEvent, AlertKind } from "@/features/tunnel/lib/alerts";
