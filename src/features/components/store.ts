// Components feature store slice (#2269) — the proven-component library, a WRITE-THROUGH cache over the
// GLOBAL component store (reached via `bsc ui` — see lib/componentBridge.ts, #2281). The planner's
// `test_ui` pane and (later) the full Design Studio page share ONE library. On boot `hydrateComponents`
// loads both collections through the bridge and reconciles the packaged built-ins with the hash-based
// seed refresh (#2483, lib/seedRefresh.ts): pristine built-in copies track the seed (refreshed/deleted),
// user-edited ones are kept with a notice, and missing built-ins are re-seeded. A no-op that keeps the
// seed when the bridge is unreachable (tests, the web shell, an old bundled `bsc`).
import type { StateCreator } from "zustand";
import type { AppStore } from "@/store/types";
import type { ComponentRecord, Kit } from "./lib/model";
import type { KitConsumer, KitChange, Dispatch } from "./lib/propagation";
import type { SeedNotice } from "./lib/seedRefresh";
import { kitUsageId, makeChange, planPropagation, dispatchKey } from "./lib/propagation";
import { SEED_COMPONENTS, SEED_KITS, reconcileComponents, reconcileKits } from "./lib/seed";
import { SEED_THEMES, reconcileThemes, orderThemes, type KitThemeRecord } from "./lib/themes";
import { loadComponents, loadKits, pushComponent, dropComponent, pushKit, dropKit } from "./lib/componentBridge";
import { loadThemes, pushTheme, dropTheme, loadVariants } from "./lib/themeBridge";
import { loadKitUsage, pushKitUsage, dropKitUsage } from "./lib/kitUsageBridge";
import { setActiveKitThemes, applyVariantsToRoot } from "@/shared/ui/kit";

export interface ComponentsSlice {
  /** The proven-component library — the typed seed until the global store lands, then its contents. */
  components: ComponentRecord[];
  /** The kits (technology-scoped namespaces) the components belong to. */
  kits: Kit[];
  /** Hydrate the library from the global `bsc ui` store on boot. No-op (keeps the seed) when the
   *  bridge is unreachable. Applies the hash-based seed refresh (#2483): pushes refreshed/added
   *  built-ins, drops deleted ones, and surfaces the kept-but-diverged outcomes as `seedNotices`. */
  hydrateComponents: () => Promise<void>;

  /** The kit THEME collection (#2488) — the packaged registry until the designer-writable theme
   *  store hydrates, then its contents (ordered: built-ins in registry order, then authored). The
   *  Settings picker + the Design Studio preview switcher read this; `themeById`/`ThemeScope`
   *  resolve against the same set via `setActiveKitThemes`. */
  kitThemes: KitThemeRecord[];
  /** Hydrate the theme collection from the global `bsc ui theme` store on boot (#2488), mirroring
   *  `hydrateComponents`: no-op (keeps the packaged seed) when the bridge is unreachable; reconciles
   *  built-ins via the #2483 seed refresh (theme notices ride the same `seedNotices` surface) and
   *  syncs the result into the shared theme resolvers. */
  hydrateThemes: () => Promise<void>;
  /** Hydrate the data-defined component variants from the global `bsc ui variants` store (#2569) and
   *  compile them into the live managed `<style>` — so an LLM-authored variant renders without a
   *  relaunch. Re-run on boot and on a `ui-touch` "variant" write. No-op when the bridge is unreachable. */
  hydrateVariants: () => Promise<void>;
  /** Built-ins kept through a seed divergence (#2483): the user's customized copy survived an
   *  upstream update, or a retired built-in was kept because it was customized. Recomputed on each
   *  hydrate (not persisted); rendered by the Design Studio's SeedNoticesCard. */
  seedNotices: SeedNotice[];
  /** Dismiss one seed notice (by type + id). */
  dismissSeedNotice: (type: SeedNotice["type"], id: string) => void;

  /** The consumer index (#2277) — which projects use which kit; the edges a kit CHANGE fans out over.
   *  A write-through cache over the global `bsc ui usage` store. */
  kitUsage: KitConsumer[];
  /** Hydrate the consumer index on boot (no-op keeping the persisted cache when unreachable). */
  hydrateKitUsage: () => Promise<void>;
  /** Record that a project uses a kit (idempotent by (projectKey, kitId)); pushes through the bridge. */
  addKitUsage: (projectKey: string, kitId: string) => void;
  /** Remove a project→kit consumer edge; pushes the removal through the bridge. */
  removeKitUsage: (projectKey: string, kitId: string) => void;

  /** Upsert a component (the change ORIGIN, #2277): write it through to the store AND — when it EDITS an
   *  existing component — emit a classified {@link KitChange} (prop/variant diff), fan it out over the
   *  consumer index (`kitUsage`), and queue the resulting `kitDispatches`. An author-declared class
   *  overrides the derived one. Adding a brand-new component is not a "change" (no diff to fan out). */
  setComponent: (component: ComponentRecord, changeOverride?: Partial<Pick<KitChange, "class" | "summary" | "migration">>) => void;
  /** Import a whole kit + its components (from a gist / share code, #2305 slice 1c) as a USER kit:
   *  collision-safe (a colliding kit or component id is freshly minted so a packaged built-in can never
   *  be clobbered), write-through to the `bsc ui` store. Returns the (possibly re-id'd) kit. */
  importKit: (kit: Kit, components: ComponentRecord[]) => Kit;
  /** The pending fan-out — the planned per-consumer dispatches a kit change produced (notify-only by
   *  default; issue/assign only for breaking + opted-in consumers). Drained by the delivery slice. */
  kitDispatches: Dispatch[];
  /** Dismiss a queued dispatch (once delivered / acknowledged), keyed by (projectKey, change.id). */
  dismissKitDispatch: (projectKey: string, changeId: string) => void;

  /** The library id the designer AI most-recently touched (#2525) — a component/kit/theme id from a
   *  `bsc ui set/remove` mutation the `useUiActivity` poll observed. The Design Studio live-focuses it
   *  (pulsing `.working` node + auto-pan). `null` when idle or the designer session ended. */
  aiFocusedId: string | null;
  /** Record a designer `ui-touch` (#2525): set {@link aiFocusedId} to the touched id AND re-pull the
   *  touched collection so the AI's edit appears live (hydrate is otherwise one-shot at boot) —
   *  `hydrateComponents` always, plus `hydrateThemes` for a `theme` touch. A `null` id clears the
   *  focus (session end) without re-hydrating. */
  setAiFocused: (id: string | null, collection?: string) => void;
}

export const createComponentsSlice: StateCreator<AppStore, [], [], ComponentsSlice> = (set, get) => ({
  components: SEED_COMPONENTS,
  kits: SEED_KITS,

  hydrateComponents: async () => {
    const [loadedC, loadedK] = await Promise.all([loadComponents(), loadKits()]);
    if (!loadedC && !loadedK) return; // bridge unreachable — keep the seed
    const rc = reconcileComponents(loadedC ?? []);
    const rk = reconcileKits(loadedK ?? []);
    // Replace only OUR notice types — theme notices (#2488) belong to hydrateThemes, which may have
    // already run (the two hydrates race on boot).
    set((s) => ({
      components: rc.records,
      kits: rk.records,
      seedNotices: [...s.seedNotices.filter((n) => n.type === "theme"), ...rk.notices, ...rc.notices],
    }));
    // Converge the store to the verdicts (#2483): push refreshed + missing built-ins (stamped with the
    // new seedHash), drop pristine copies of retired built-ins. User records are never pushed/dropped.
    for (const c of rc.pushes) void pushComponent(c);
    for (const id of rc.drops) void dropComponent(id);
    for (const k of rk.pushes) void pushKit(k);
    for (const id of rk.drops) void dropKit(id);
  },

  kitThemes: SEED_THEMES,

  hydrateThemes: async () => {
    const loaded = await loadThemes();
    if (!loaded) return; // bridge unreachable — keep the packaged seed (already the active set)
    const rt = reconcileThemes(loaded);
    const records = orderThemes(rt.records);
    set((s) => ({
      kitThemes: records,
      seedNotices: [...s.seedNotices.filter((n) => n.type !== "theme"), ...rt.notices],
    }));
    // Sync the shared resolvers (themeById/themeVars/ThemeScope/applyThemeToRoot) to the same set.
    setActiveKitThemes(records);
    // Converge the store (#2483): materialize refreshed + missing built-ins, drop pristine retirees.
    for (const t of rt.pushes) void pushTheme(t);
    for (const id of rt.drops) void dropTheme(id);
  },

  hydrateVariants: async () => {
    const defs = await loadVariants();
    if (defs) applyVariantsToRoot(defs); // bridge unreachable (null) → keep the current managed <style>
  },

  seedNotices: [],

  dismissSeedNotice: (type, id) =>
    set((s) => ({ seedNotices: s.seedNotices.filter((n) => !(n.type === type && n.id === id)) })),

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

  kitDispatches: [],

  setComponent: (component, changeOverride) => {
    const before = get().components.find((c) => c.id === component.id);
    set((s) => ({
      components: s.components.some((c) => c.id === component.id)
        ? s.components.map((c) => (c.id === component.id ? component : c))
        : [...s.components, component],
    }));
    void pushComponent(component);
    if (!before) return; // a brand-new component isn't a change to fan out
    const dispatches = planPropagation(makeChange(component, before, changeOverride), get().kitUsage);
    if (!dispatches.length) return;
    set((s) => {
      const seen = new Set(s.kitDispatches.map(dispatchKey));
      const fresh = dispatches.filter((d) => !seen.has(dispatchKey(d)));
      return fresh.length ? { kitDispatches: [...s.kitDispatches, ...fresh] } : {};
    });
  },

  importKit: (kit, components) => {
    const freshId = (base: string, taken: Set<string>): string => {
      if (!taken.has(base)) return base;
      let n = 2;
      while (taken.has(`${base}-${n}`)) n++;
      return `${base}-${n}`;
    };
    const kitId = freshId(kit.id, new Set(get().kits.map((k) => k.id)));
    // An import is user-owned: never a built-in, and never carrying a seed baseline (#2483) — a stale
    // seedHash from an exported built-in must not ride along.
    const newKit: Kit = { ...kit, id: kitId, builtin: false, seedHash: undefined };
    const compIds = new Set(get().components.map((c) => c.id));
    const newComps: ComponentRecord[] = components.map((c) => {
      const id = freshId(c.id, compIds);
      compIds.add(id);
      return { ...c, id, kitId, builtin: false, seedHash: undefined };
    });
    set((s) => ({ kits: [...s.kits, newKit], components: [...s.components, ...newComps] }));
    void pushKit(newKit);
    for (const c of newComps) void pushComponent(c);
    return newKit;
  },

  dismissKitDispatch: (projectKey, changeId) =>
    set((s) => ({ kitDispatches: s.kitDispatches.filter((d) => !(d.projectKey === projectKey && d.change.id === changeId)) })),

  aiFocusedId: null,

  setAiFocused: (id, collection) => {
    set({ aiFocusedId: id });
    if (!id) return; // a clear (session end) — no re-pull
    // Re-hydrate the touched collection so the AI's edit shows without a relaunch (#2483/#2514/#2525).
    void get().hydrateComponents();
    if (collection === "theme") void get().hydrateThemes();
    if (collection === "variant") void get().hydrateVariants();
  },
});
