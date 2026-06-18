// Mobile tunnel — Tauri command wrappers (#243).
//
// Thin typed bindings to the Rust relay client (`src-tauri/src/tunnel.rs`). Kept apart
// from `tunnel.ts` so that module stays free of Tauri imports and unit-testable; this
// one is the side-effecting boundary the Settings card and ConsoleScreen call.

import { invoke } from "@tauri-apps/api/core";
import type { PaneDescriptor, SessionMeta, TunnelStatus } from "./tunnel";
import type { CanonicalFile } from "./plannerCore";

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

/** Probe the relay's `/health` endpoint and return per-leg connection diagnostics (T3b).
 *  Always resolves (never rejects) — check `error` for failure details. */
export const tunnelCheckRelay = (relayUrl: string): Promise<RelayDiag> =>
  invoke("tunnel_check_relay", { relayUrl });
