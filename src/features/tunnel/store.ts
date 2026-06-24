// Tunnel feature store slice (#1309) — the mobile-relay connection state. Extracted from the
// residual `shell` slice (formerly the `github` grab-bag). Composed by store/index.ts.
import type { StateCreator } from "zustand";
import type { AppStore } from "@/store/types";
import type { PaneDescriptor } from "./lib/tunnel";

export interface TunnelSlice {
  // The relay Worker URL is persisted (the user's BYO relay); `tunnelRunning` mirrors the Rust
  // client's connected state (transient) so ConsoleScreen knows whether to push live pane metadata.
  tunnelRelayUrl: string;
  setTunnelRelayUrl: (url: string) => void;
  tunnelRunning: boolean;
  setTunnelRunning: (v: boolean) => void;
  /** Ad-hoc panes (e.g. the active planner pane) mirrored over the relay alongside the Console
   *  panes (#801). Transient — not persisted. */
  tunnelExtraPanes: PaneDescriptor[];
  setTunnelExtraPanes: (panes: PaneDescriptor[]) => void;
}

export const createTunnelSlice: StateCreator<AppStore, [], [], TunnelSlice> = (set) => ({
  tunnelRelayUrl: "",
  setTunnelRelayUrl: (url) => set({ tunnelRelayUrl: url }),
  tunnelRunning: false,
  setTunnelRunning: (v) => set({ tunnelRunning: v }),
  tunnelExtraPanes: [],
  setTunnelExtraPanes: (panes) => set({ tunnelExtraPanes: panes }),
});
