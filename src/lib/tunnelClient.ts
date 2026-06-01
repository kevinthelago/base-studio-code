// Mobile tunnel — Tauri command wrappers (#243).
//
// Thin typed bindings to the Rust relay client (`src-tauri/src/tunnel.rs`). Kept apart
// from `tunnel.ts` so that module stays free of Tauri imports and unit-testable; this
// one is the side-effecting boundary the Settings card and ConsoleScreen call.

import { invoke } from "@tauri-apps/api/core";
import type { PaneDescriptor, SessionMeta, TunnelStatus } from "./tunnel";

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

/** Push the current pane list to connected clients. */
export const tunnelSetPanes = (panes: PaneDescriptor[]): Promise<void> =>
  invoke("tunnel_set_panes", { panes });

/** Push per-pane session-state snapshots to connected clients. */
export const tunnelSetSessions = (sessions: SessionMeta[]): Promise<void> =>
  invoke("tunnel_set_sessions", { sessions });
