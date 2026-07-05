// Mobile tunnel — Tauri command wrappers (#243).
//
// Thin typed bindings to the Rust relay client (`src-tauri/src/tunnel.rs`). Kept apart
// from `tunnel.ts` so that module stays free of Tauri imports and unit-testable; this
// one is the side-effecting boundary the Settings card and ConsoleWorkspace call.

import { invoke } from "@tauri-apps/api/core";
import type {
  PaneDescriptor, SessionMeta, TunnelStatus,
  PlanMessage, PlanPipelineRun, PlanEventKind,
} from "./tunnel";
import type { CanonicalFile } from "@/features/planner";

/** Structured result from `tunnelCheckRelay` (T3b). All error cases are in the `error`
 *  field — the command never throws so the Settings card can render a result either way. */
export interface RelayDiag {
  /** Whether the relay's `/health` probe returned HTTP 200. */
  reachable: boolean;
  /** `service` from the relay `/health` body. */
  service: string | null;
  /** `version` from the relay `/health` body. */
  version: string | null;
  /** Round-trip latency for the probe (milliseconds). */
  latencyMs: number;
  /** Human-readable error message when the probe fails. */
  error: string | null;
  /** Whether the desktop's own relay WebSocket (host leg) is currently open. */
  hostConnected: boolean;
  /** Number of paired mobile clients (guest legs) connected right now. */
  clientCount: number;
}

/** Mint a room + pairing secret and dial the relay. Returns the updated status. */
export const tunnelStart = (relayUrl: string): Promise<TunnelStatus> =>
  invoke("tunnel_start", { relayUrl });

/** Stop the relay client and clear the pairing. */
export const tunnelStop = (): Promise<TunnelStatus> => invoke("tunnel_stop");

/** Current tunnel status (running, room, hostPubKey, client count, …). */
export const tunnelStatus = (): Promise<TunnelStatus> => invoke("tunnel_status");

/** Grant or revoke the paired phone's input control (#B-wan-viewonly). A paired phone is
 *  view-only until granted; revoking returns it to view-only. Returns the updated status. */
export const tunnelSetInputGranted = (granted: boolean): Promise<TunnelStatus> =>
  invoke("tunnel_set_input_granted", { granted });

/** Unpair the current device (#B-unpair-revoke): tear down the relay room, rotate the
 *  pairing secret (the old QR dies), and reconnect on a fresh room. Returns the updated
 *  status carrying the new room + QR. */
export const tunnelUnpair = (): Promise<TunnelStatus> => invoke("tunnel_unpair");

/** Push the current pane list to connected clients. */
export const tunnelSetPanes = (panes: PaneDescriptor[]): Promise<void> =>
  invoke("tunnel_set_panes", { panes });

/** Push per-pane session-state snapshots to connected clients. */
export const tunnelSetSessions = (sessions: SessionMeta[]): Promise<void> =>
  invoke("tunnel_set_sessions", { sessions });

/** Push the active project's canonical plan (files + manifest) to the relay so a paired
 *  mobile planner syncs over the tunnel instead of hitting the API (#801). `projectId` is
 *  the canonical `proj-<hex>` id from `hubToCanonical`. */
export const tunnelSetPlanState = (projectId: string, files: CanonicalFile[]): Promise<void> =>
  invoke("tunnel_set_plan_state", { projectId, files });

/** Acknowledge a plan push from mobile after the frontend has applied the files to the
 *  hub directory. Broadcasts `plan_sync_ack` back to the mobile client. */
export const tunnelAckPlanPush = (projectId: string, applied: boolean): Promise<void> =>
  invoke("tunnel_ack_plan_push", { projectId, applied });

// ── Live planning session (PT1 / #934 / #986) ─────────────────────────────────
// Project the LIVE planner UI state to a paired phone — distinct from tunnelSetPlanState
// (the async file-sync path, which stays as-is). State + status are stored Rust-side and
// replayed on connect; events are fire-and-forget.

/** Push the full live planner snapshot (replayed to newly-paired clients). */
export const tunnelEmitPlanState = (
  projectId: string,
  currentStage: string,
  confirmedSections: string[],
  files: CanonicalFile[],
  messages: PlanMessage[],
  pipelineRuns: PlanPipelineRun[],
): Promise<void> =>
  invoke("tunnel_emit_plan_state", { projectId, currentStage, confirmedSections, files, messages, pipelineRuns });

/** Push the cheap header update (active stage + status); replayed on connect. */
export const tunnelEmitPlanStatus = (projectId: string, currentStage: string, status: string): Promise<void> =>
  invoke("tunnel_emit_plan_status", { projectId, currentStage, status });

/** A transient planning delta — fire-and-forget (not replayed). Detail fields are set per `kind`. */
export interface PlanEventInput {
  kind: PlanEventKind;
  at: number;
  section?: string;
  stage?: string;
  message?: PlanMessage;
  run?: PlanPipelineRun;
}

/** Push a transient planning event to connected clients. */
export const tunnelEmitPlanEvent = (projectId: string, ev: PlanEventInput): Promise<void> =>
  invoke("tunnel_emit_plan_event", {
    projectId, kind: ev.kind, at: ev.at,
    section: ev.section, stage: ev.stage, message: ev.message, run: ev.run,
  });

/** Probe the relay's `/health` endpoint and return per-leg connection diagnostics (T3b).
 *  Always resolves (never rejects) — check `error` for failure details. */
export const tunnelCheckRelay = (relayUrl: string): Promise<RelayDiag> =>
  invoke("tunnel_check_relay", { relayUrl });

// ── F2: fleet / coordination ─────────────────────────────────────────────────

/** Wire shape for one agent session in the fleet roster. Mirrors Rust `FleetSession`. */
export interface FleetSession {
  session: string;
  /** "running" | "blocked" | "waiting" | "asking" | "idle" */
  status: string;
  /** Present and non-empty when `status == "blocked"`. */
  blockedOn?: string[];
  waitReason?: string | null;
  question?: string | null;
  /** ms-epoch timestamp of the last status change. */
  at: number;
}

/** Push the current fleet roster to connected mobile clients. Replayed on connect. */
export const tunnelSetFleetState = (sessions: FleetSession[]): Promise<void> =>
  invoke("tunnel_set_fleet_state", { sessions });

/** Broadcast a single coordination event to connected clients.
 *  When `kind` is "waiting" or "asking", also triggers an FCM push (F4). */
export const tunnelEmitCoordEvent = (
  kind: string,
  session?: string,
  refKey?: string,
  at?: number,
): Promise<void> =>
  invoke("tunnel_emit_coord_event", { kind, session: session ?? null, refKey: refKey ?? null, at: at ?? Date.now() });

// ── A2: automations ──────────────────────────────────────────────────────────

/** Wire shape for one automation descriptor. Mirrors Rust `AutomationFrame`. */
export interface AutomationFrame {
  id: string;
  name: string;
  armed: boolean;
  /** Human-readable schedule expression or cron string. */
  whenExpr: string;
  lastRunAt?: number | null;
  nextRunAt?: number | null;
  /** "ok" | "fail" | "skipped" */
  lastStatus?: string | null;
}

/** Push the full automation list to connected mobile clients. Replayed on connect. */
export const tunnelSetAutomations = (automations: AutomationFrame[]): Promise<void> =>
  invoke("tunnel_set_automations", { automations });

/** Push an automation-ran notification (informational, no FCM push). */
export const tunnelAutomationRan = (id: string, at: number, status: string, note: string): Promise<void> =>
  invoke("tunnel_automation_ran", { id, at, status, note });

/** Push an automation-failed notification. Also queues an FCM push (A4). */
export const tunnelAutomationFailed = (id: string, at: number, error: string, name: string): Promise<void> =>
  invoke("tunnel_automation_failed", { id, at, error, name });

// ── M2: MCP extensions ───────────────────────────────────────────────────────

/** Wire shape for one MCP server / hook descriptor. Mirrors Rust `McpExtFrame`. */
export interface McpExtFrame {
  id: string;
  /** "mcp" | "hook" */
  kind: string;
  name: string;
  enabled: boolean;
  /** "stdio" | "http" — present for MCP servers, null for hooks. */
  transport?: string | null;
  url?: string | null;
}

/** Push the full MCP extension list to connected mobile clients. Read-only on mobile.
 *  Replayed on connect. */
export const tunnelSetMcpState = (extensions: McpExtFrame[]): Promise<void> =>
  invoke("tunnel_set_mcp_state", { extensions });

// ── M3: hook telemetry (#937) ─────────────────────────────────────────────────

/** One day's allow/block counts. Mirrors Rust `HookDayBucket` / TS `DayBucket`. */
export interface HookDayBucket {
  /** Local YYYY-MM-DD. */
  day: string;
  allows: number;
  blocks: number;
}

/** Fires for one hook. Mirrors Rust `HookCountFrame` / TS `HookCount`. */
export interface HookCountFrame {
  hook: string;
  /** PreToolUse | PostToolUse | Stop | … */
  event: string;
  fires: number;
}

/** Wire shape for the aggregated hook-fire telemetry. Mirrors Rust `HookTelemetryFrame`,
 *  itself a projection of `HookAnalytics` (src/features/mcp/lib/hookTelemetry.ts). */
export interface HookTelemetryFrame {
  total: number;
  blocks: number;
  allows: number;
  /** allows / (allows + blocks), 0–100. */
  allowRate: number;
  daily: HookDayBucket[];
  perHook: HookCountFrame[];
}

/** Push the aggregated hook-fire telemetry summary to connected mobile clients. Read-only
 *  on mobile — there is no inbound counterpart. Replayed on connect. */
export const tunnelSetHookTelemetry = (telemetry: HookTelemetryFrame): Promise<void> =>
  invoke("tunnel_set_hook_telemetry", { telemetry });
