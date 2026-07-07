// Tunnel feature store slice (#1309) — the mobile-relay connection state. Extracted from the
// residual `shell` slice (formerly the `github` grab-bag). Composed by store/index.ts.
import type { StateCreator } from "zustand";
import type { AppStore } from "@/store/types";
import type { PaneDescriptor } from "./lib/tunnel";

export interface TunnelSlice {
  // The relay Worker URL is persisted (the user's BYO relay); `tunnelRunning` mirrors the Rust
  // client's connected state (transient) so ConsoleWorkspace knows whether to push live pane metadata.
  tunnelRelayUrl: string;
  setTunnelRelayUrl: (url: string) => void;
  tunnelRunning: boolean;
  setTunnelRunning: (v: boolean) => void;
  /** Ad-hoc session panes outside the Console tab grid, mirrored over the relay alongside the
   *  Console panes (#801/#2497), keyed by the REGISTERING SOURCE (`"planner"`, `"designer"`, …)
   *  so independent owners never clobber each other. Transient — not persisted. */
  tunnelExtraPanes: Record<string, PaneDescriptor[]>;
  /** Register (or replace) one source's mirrored panes; pass `[]` to unregister the source. */
  registerTunnelPanes: (source: string, panes: PaneDescriptor[]) => void;
}

export const createTunnelSlice: StateCreator<AppStore, [], [], TunnelSlice> = (set) => ({
  tunnelRelayUrl: "",
  setTunnelRelayUrl: (url) => set({ tunnelRelayUrl: url }),
  tunnelRunning: false,
  setTunnelRunning: (v) => set({ tunnelRunning: v }),
  tunnelExtraPanes: {},
  registerTunnelPanes: (source, panes) =>
    set((s) => {
      const next = { ...s.tunnelExtraPanes };
      if (panes.length === 0) delete next[source];
      else next[source] = panes;
      return { tunnelExtraPanes: next };
    }),
});
