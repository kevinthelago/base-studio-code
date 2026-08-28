// The networks slice — a WRITE-THROUGH CACHE over the global network store (`bsc network`).
//
// A NETWORK is a domain: the set of projects that share one concern, drawn as one Glance tab, and the
// owner of exactly one architect session. The desktop, a live session's own shell and the architect all
// read the same store; on boot `hydrateNetworks` loads through the bridge, and every mutation below
// pushes through. The in-memory copy exists only for a fast first paint.
//
// DELIBERATELY NOT PERSISTED. `persistedState` is re-serialized on every store `set()`, and its own doc
// forbids putting anything a `bsc` store owns and re-hydrates at boot into it — a persisted copy is a
// duplicated source of truth that goes stale, and a large one freezes the app.
import type { StateCreator } from "zustand";
import type { AppStore } from "@/store/types";
import {
  loadNetworks, pushNetwork, dropNetwork, projectsByNetwork, mintNetworkId, type Network,
} from "@/features/networks/lib/networkBridge";

export interface NetworksSlice {
  /** Every network, tab order first. Hydrated from `bsc network`; never persisted. */
  networks: Network[];
  /** Load from the store. Authoritative — a null read (bridge unreachable) LEAVES what is there rather
   *  than blanking the tab strip, which is why the bridge distinguishes the two. */
  hydrateNetworks: () => Promise<void>;
  /** Create one from a display name; returns its minted id. Idempotent only in the sense that a
   *  colliding name gets a fresh id rather than overwriting — see `mintNetworkId`. */
  addNetwork: (name: string) => string;
  /** Rename — DISPLAY ONLY. The id is frozen because the architect's pane id and workspace dir derive
   *  from it, and renaming those would strand a running session. */
  renameNetwork: (id: string, name: string) => void;
  /**
   * Delete a network. REFUSES while any project is still filed into it, resolving to `false`.
   *
   * A network is not the owner of its projects — membership is a column on each project row — so a
   * delete cannot cascade, and removing it anyway would leave those projects pointing at nothing:
   * present in `bsc project list`, absent from every tab. Refusing is the recoverable answer, and the
   * caller is told which projects are in the way.
   */
  removeNetwork: (id: string) => Promise<{ ok: boolean; blockedBy: string[] }>;
}

export const createNetworksSlice: StateCreator<AppStore, [], [], NetworksSlice> = (set, get) => ({
  networks: [],

  hydrateNetworks: async () => {
    const rows = await loadNetworks();
    if (rows === null) return; // unreachable bridge — keep what we have
    set({ networks: rows });
  },

  addNetwork: (name) => {
    const trimmed = name.trim() || "network";
    const id = mintNetworkId(get().networks, trimmed);
    const network: Network = {
      id,
      name: trimmed,
      position: get().networks.reduce((max, n) => Math.max(max, n.position), -1) + 1,
    };
    set((s) => ({ networks: [...s.networks, network] }));
    void pushNetwork(network);
    return id;
  },

  renameNetwork: (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return; // an empty name is dropped, matching TabBar's own inline-rename contract
    let updated: Network | undefined;
    set((s) => ({
      networks: s.networks.map((n) => {
        if (n.id !== id) return n;
        // The id is re-pinned rather than spread-over: a patch must never be able to move it.
        updated = { ...n, name: trimmed, id: n.id };
        return updated;
      }),
    }));
    if (updated) void pushNetwork(updated);
  },

  removeNetwork: async (id) => {
    const blockedBy = (await projectsByNetwork()).filter((p) => p.network === id).map((p) => p.key);
    if (blockedBy.length > 0) return { ok: false, blockedBy };
    set((s) => ({ networks: s.networks.filter((n) => n.id !== id) }));
    void dropNetwork(id);
    return { ok: true, blockedBy: [] };
  },
});
