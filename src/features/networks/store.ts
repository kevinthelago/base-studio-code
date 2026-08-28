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

/** The kitchen-sink domain — where everything not yet organised lives, and what a fresh install opens
 *  on. Must match `bsc_project::store::DEFAULT_NETWORK_ID`, which is what the migration writes onto every
 *  pre-existing project row. */
export const DEFAULT_NETWORK_ID = "network-kitchen";

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

    // RECONCILE, not just load. Two stores hold the two halves of a network and neither writes the
    // other: `bsc project network set` (and the kitchen migration) writes the id onto a PROJECT row,
    // while the network's own row lives here. They can therefore disagree — and did, on every machine
    // that upgraded: the migration filed all 27 projects into `network-kitchen` while
    // `bsc network list` returned nothing, so Glance had no tab to draw them in.
    //
    // Creating what is referenced-but-missing heals that in the direction that cannot lose data: a
    // project naming a network is evidence the network should exist. The reverse is never done — an
    // empty network is perfectly legitimate and must not be swept away.
    const referenced = new Set(
      (await projectsByNetwork()).map((p) => p.network).filter((n): n is string => !!n),
    );
    const have = new Set(rows.map((n) => n.id));
    const missing = [...referenced].filter((id) => !have.has(id)).sort();

    // …and with NOTHING at all, `kitchen` — the kitchen-sink domain. Every Glance tab is a domain, so a
    // fresh install must open on one rather than on an empty strip with only a `+`.
    if (rows.length === 0 && missing.length === 0) missing.push(DEFAULT_NETWORK_ID);

    if (missing.length === 0) { set({ networks: rows }); return; }

    const created = missing.map((id, i) => ({
      id,
      // `network-kitchen` → `kitchen`. The id is the only thing that survived the migration, so the
      // name is derived from it rather than invented; the user renames it freely afterwards.
      name: id.startsWith("network-") ? id.slice("network-".length) : id,
      position: rows.length + i,
    }));
    for (const n of created) void pushNetwork(n);
    set({ networks: [...rows, ...created] });
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
