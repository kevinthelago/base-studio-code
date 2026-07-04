// Components feature store slice (#2269) — the proven-component library, a cache over the GLOBAL
// component store (reached via `bsc component` — see lib/componentBridge.ts). The planner's `test_ui`
// pane and (later) the full Design Studio page share ONE library. On boot `hydrateComponents` loads
// through the bridge; a no-op that keeps the typed seed when the bridge is unreachable (tests, the web
// shell, or — for now — every build, since the `bsc component` store isn't built yet).
//
// Read-only for now: the pane's variant-generate loop is optimistic + local (it doesn't yet persist).
// Write-through mutations land with the `bsc component` store crate (a follow-up issue).
import type { StateCreator } from "zustand";
import type { AppStore } from "@/store/types";
import type { ComponentRecord, Kit } from "./lib/model";
import { SEED_COMPONENTS, SEED_KITS } from "./lib/seed";
import { loadComponents } from "./lib/componentBridge";

export interface ComponentsSlice {
  /** The proven-component library — the typed seed until the global store lands, then its contents. */
  components: ComponentRecord[];
  /** The kits (technology-scoped namespaces) the components belong to. */
  kits: Kit[];
  /** Hydrate the library from the global `bsc component` store on boot. No-op (keeps the seed) when the
   *  bridge is unreachable. */
  hydrateComponents: () => Promise<void>;
}

export const createComponentsSlice: StateCreator<AppStore, [], [], ComponentsSlice> = (set) => ({
  components: SEED_COMPONENTS,
  kits: SEED_KITS,

  hydrateComponents: async () => {
    const loaded = await loadComponents();
    if (loaded && loaded.length) set({ components: loaded }); // else keep the seed
  },
});
