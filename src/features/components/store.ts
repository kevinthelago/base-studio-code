// Components feature store slice (#2269) — the proven-component library, a WRITE-THROUGH cache over the
// GLOBAL component store (reached via `bsc component` — see lib/componentBridge.ts, #2281). The planner's
// `test_ui` pane and (later) the full Design Studio page share ONE library. On boot `hydrateComponents`
// loads both collections through the bridge, reconciles the packaged built-ins, and re-seeds any the
// store lacks — the persona/org pattern. A no-op that keeps the seed when the bridge is unreachable
// (tests, the web shell, an old bundled `bsc`).
import type { StateCreator } from "zustand";
import type { AppStore } from "@/store/types";
import type { ComponentRecord, Kit } from "./lib/model";
import type { KitConsumer } from "./lib/propagation";
import { kitUsageId } from "./lib/propagation";
import { SEED_COMPONENTS, SEED_KITS, reconcileComponents, reconcileKits } from "./lib/seed";
import { loadComponents, loadKits, pushComponent, pushKit } from "./lib/componentBridge";
import { loadKitUsage, pushKitUsage, dropKitUsage } from "./lib/kitUsageBridge";

export interface ComponentsSlice {
  /** The proven-component library — the typed seed until the global store lands, then its contents. */
  components: ComponentRecord[];
  /** The kits (technology-scoped namespaces) the components belong to. */
  kits: Kit[];
  /** Hydrate the library from the global `bsc component` store on boot. No-op (keeps the seed) when the
   *  bridge is unreachable. */
  hydrateComponents: () => Promise<void>;

  /** The consumer index (#2277) — which projects use which kit; the edges a kit CHANGE fans out over.
   *  A write-through cache over the global `bsc component usage` store. */
  kitUsage: KitConsumer[];
  /** Hydrate the consumer index on boot (no-op keeping the persisted cache when unreachable). */
  hydrateKitUsage: () => Promise<void>;
  /** Record that a project uses a kit (idempotent by (projectKey, kitId)); pushes through the bridge. */
  addKitUsage: (projectKey: string, kitId: string) => void;
  /** Remove a project→kit consumer edge; pushes the removal through the bridge. */
  removeKitUsage: (projectKey: string, kitId: string) => void;
}

export const createComponentsSlice: StateCreator<AppStore, [], [], ComponentsSlice> = (set) => ({
  components: SEED_COMPONENTS,
  kits: SEED_KITS,

  hydrateComponents: async () => {
    const [loadedC, loadedK] = await Promise.all([loadComponents(), loadKits()]);
    if (!loadedC && !loadedK) return; // bridge unreachable — keep the seed
    const components = reconcileComponents(loadedC ?? []);
    const kits = reconcileKits(loadedK ?? []);
    set({ components, kits });
    // Converge the store: re-push any built-in it lacks (first run / a newly-packaged component or kit),
    // so a session reading `bsc component …` sees the full seeded library. User records are preserved by
    // reconcile, so only genuinely-missing built-ins re-push.
    const haveC = new Set((loadedC ?? []).map((c) => c.id));
    for (const c of components) if (c.builtin && !haveC.has(c.id)) void pushComponent(c);
    const haveK = new Set((loadedK ?? []).map((k) => k.id));
    for (const k of kits) if (k.builtin && !haveK.has(k.id)) void pushKit(k);
  },

  kitUsage: [],

  hydrateKitUsage: async () => {
    const loaded = await loadKitUsage();
    if (loaded) set({ kitUsage: loaded }); // bridge unreachable → keep the persisted cache
  },

  addKitUsage: (projectKey, kitId) => {
    if (!projectKey || !kitId) return;
    let added = false;
    set((s) => {
      if (s.kitUsage.some((u) => u.projectKey === projectKey && u.kitId === kitId)) return {};
      added = true;
      return { kitUsage: [...s.kitUsage, { projectKey, kitId }] };
    });
    if (added) void pushKitUsage(projectKey, kitId);
  },

  removeKitUsage: (projectKey, kitId) => {
    set((s) => ({ kitUsage: s.kitUsage.filter((u) => !(u.projectKey === projectKey && u.kitId === kitId)) }));
    void dropKitUsage(kitUsageId(projectKey, kitId));
  },
});
