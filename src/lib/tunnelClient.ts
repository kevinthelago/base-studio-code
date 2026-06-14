// Mobile tunnel — Tauri command wrappers (#243).
//
// Thin typed bindings to the Rust relay client (`src-tauri/src/tunnel.rs`). Kept apart
// from `tunnel.ts` so that module stays free of Tauri imports and unit-testable; this
// one is the side-effecting boundary the Settings card and ConsoleScreen call.

import { invoke } from "@tauri-apps/api/core";
import type { PaneDescriptor, SessionMeta, TunnelStatus } from "./tunnel";
import type { CanonicalFile } from "./plannerCore";

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
