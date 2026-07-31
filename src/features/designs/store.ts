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
import type { ComponentBuildStatus, RuntimeStateCategory } from "./lib/componentScan";
import type { PreviewState } from "./lib/componentPreview";
import type { KitConsumer, KitChange, Dispatch } from "./lib/propagation";
import type { SeedNotice } from "./lib/seedRefresh";
import type { DesignDirective } from "./lib/designerQueue";
import { DEFAULT_MAX_TURNS, DRIVER, DESIGNER } from "./lib/designerLoopDrive";
import { bsc, bscRun } from "@/shared/lib/core/bsc";
import { kitUsageId, makeChange, planPropagation, dispatchKey } from "./lib/propagation";
import { SEED_COMPONENTS, SEED_KITS, reconcileComponents, reconcileKits } from "./lib/seed";
import { SEED_THEMES, reconcileThemes, orderThemes, type KitThemeRecord } from "./lib/themes";
import { loadComponents, loadComponentsGraph, loadKits, pushComponent, dropComponent, pushKit, dropKit } from "./lib/componentBridge";
import { loadThemes, pushTheme, dropTheme, loadVariants } from "./lib/themeBridge";
import { loadKitUsage, pushKitUsage, dropKitUsage } from "./lib/kitUsageBridge";
import { setActiveKitThemes, applyVariantsToRoot, applyContributionsToRoot, applyAnimationsToRoot, kitAnimations, type DesignContributionOverlay } from "@/shared/ui/kit";

/** Merge fresh kit-change dispatches into the queue, deduped by `dispatchKey` — shared by the two
 *  change-origins: the desktop `setComponent` edit and the `ui-touch`/CLI-edit diff (#2810). Exported
 *  for the unit test. */
export function mergeDispatches(current: Dispatch[], fresh: Dispatch[]): Dispatch[] {
  const seen = new Set(current.map(dispatchKey));
  const add = fresh.filter((d) => !seen.has(dispatchKey(d)));
  return add.length ? [...current, ...add] : current;
}

/** Has a component's PUBLIC CONTRACT (what consumers depend on) changed — props, variants, or version?
 *  The gate for firing propagation from a `ui-touch` diff, so the 65 components a designer DIDN'T edit
 *  don't queue noise on every touch. Exported for the unit test. */
export function contractChanged(before: ComponentRecord, after: ComponentRecord): boolean {
  return (
    JSON.stringify([before.props, before.variants, before.version]) !==
    JSON.stringify([after.props, after.variants, after.version])
  );
}

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

  /** Design contributions (#2656) — the token overlays downloaded blueprints contribute (their
   *  reconciled + generated categories, #2646/#2650/#2636). PERSISTED + applied on boot: a
   *  compose-don't-mutate layer the running app follows, never written into the shared contract. */
  designContributions: DesignContributionOverlay[];
  /** Register/replace a blueprint's contribution (upsert by `source`) + apply it live. */
  addDesignContribution: (overlay: DesignContributionOverlay) => void;
  /** Drop a source's contribution + re-apply the rest (e.g. the blueprint is removed). */
  removeDesignContribution: (source: string) => void;
  /** Built-ins kept through a seed divergence (#2483): the user's customized copy survived an
   *  upstream update, or a retired built-in was kept because it was customized. Recomputed on each
   *  hydrate (not persisted). No longer surfaced in a UI pane — the in-Studio SeedNoticesCard was
   *  removed (#2948); the reconcile still tracks these for `dismissSeedNotice`/future surfacing. */
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
  /** Auto-apply kit changes (#2944, default ON #2968) — when ON (default) a designer change propagates
   *  to its consumers without the approval gate; when OFF the KitChangesBanner presents it for the user
   *  to approve. Surfaced in Planner settings; persisted. */
  autoApplyKitChanges: boolean;
  setAutoApplyKitChanges: (on: boolean) => void;
  /** Remove ALL of a kit change's queued dispatches at once (#2951) — the KitChangesBanner's Approve
   *  (after delivering to any live consumer) and Dismiss both call this, so confirming a change
   *  actually clears it from the queue instead of leaving it to the drain (which only fires for a live
   *  consumer, so a non-live one's change would never leave — and reappear after a restart). */
  dismissKitChange: (changeId: string) => void;

  /** The Design Studio's SELECTED kit + component (#3274). Lifted out of `DesignsWorkbench`'s local
   *  `useState` because two surfaces now need it: the user clicking a node, and `bsc navigate component
   *  <kit> <component>` steering the app so a capture can target something. While it was local state
   *  nothing outside the UI could select a component, so `bsc shot` could only photograph whatever
   *  happened to be on screen.
   *
   *  TRANSIENT — deliberately NOT persisted. `designsCompId` starting null on each boot is what keeps
   *  the Inspector hidden-when-empty (#3090, restoring #2705); persisting it would reopen the app
   *  pre-focused and quietly undo that. `designsKitId` empty ⇒ the workbench falls back to the first
   *  kit, exactly as the old lazy `useState(() => kits[0]?.id)` did. */
  designsKitId: string;
  /** `null` ⇒ nothing focused (the Inspector hides unless the AI is working a node). */
  designsCompId: string | null;
  /** Select a kit; clears the component selection (a component belongs to exactly one kit). */
  setDesignsKit: (id: string) => void;
  setDesignsComp: (id: string | null) => void;

  /** The preview's DATA-STATE axis (#3717) — `loaded` (demo) · `empty` (no data) · `loading` (skeleton).
   *  In the STORE (not local to the workbench) so BOTH the state SegmentedControl AND `bsc navigate
   *  component --state <s>` drive one value — the latter lets an external session (the overnight loop)
   *  deliberately capture a specific render via `bsc shot frame`. TRANSIENT (not persisted): it resets to
   *  `loaded` each boot, so a stale state never survives to be "leftover" on the next render. */
  designsPreviewState: PreviewState;
  setDesignsPreviewState: (s: PreviewState) => void;

  /** The library id the designer AI most-recently touched (#2525) — a component/kit/theme id from a
   *  `bsc ui set/remove` mutation the `useUiActivity` poll observed. The Design Studio live-focuses it
   *  (pulsing `.working` node + auto-pan). `null` when idle or the designer session ended. */
  aiFocusedId: string | null;
  /** Record a designer `ui-touch` (#2525): set {@link aiFocusedId} to the touched id AND re-pull the
   *  touched collection so the AI's edit appears live (hydrate is otherwise one-shot at boot) —
   *  `hydrateComponents` always, plus `hydrateThemes` for a `theme` touch. A `null` id clears the
   *  focus (session end) without re-hydrating. */
  /** Live-focus the node Claude is on (#2525). `opts.hydrate` (default true) re-pulls the collection so a
   *  WRITE's edit shows; a READ-focus (#3545 `ui-focus`) passes `false` — the preview follows Claude's
   *  inspection without a library refetch on every `get`. */
  setAiFocused: (id: string | null, collection?: string, opts?: { hydrate?: boolean }) => void;

  /** Per-component preview-BUILD status (#2838) — component id → ok | error(message), populated lazily
   *  by the on-visit `useComponentScan` sweep (esbuild-builds each buildable component in the active
   *  kit, throttled). The Design Studio graph badges the `error` entries. TRANSIENT: not persisted (a
   *  fresh scan repopulates on each visit), so it never goes stale on disk. */
  componentBuildStatus: Record<string, ComponentBuildStatus>;
  /** Record one component's build outcome — the scan's per-result write (upsert by id). */
  setComponentBuildStatus: (id: string, status: ComponentBuildStatus) => void;

  /** Per-component RUNTIME data-state blanks (#3191) — component id → the render-confirmed
   *  `empty-empty-state` / `empty-loading-state` categories, populated by the same on-visit scan. The
   *  Design Studio graph folds these into its health badges (`nodeHealth`). TRANSIENT: not persisted (a
   *  fresh scan repopulates on each visit). */
  componentStateHealth: Record<string, RuntimeStateCategory[]>;
  /** Record one component's data-state blanks — the scan's per-result write (upsert by id; `[]` clears). */
  setComponentStateHealth: (id: string, categories: RuntimeStateCategory[]) => void;

  /** The OVERNIGHT designer-loop run (#3304, epic #3260) — `null` when off, which is ALWAYS the boot
   *  state: deliberately absent from `partialize`, so an autonomous token-spending run can never
   *  auto-start or survive a restart. Only {@link startDesignerOvernight} (a user click) sets it. */
  designerOvernight: DesignerOvernightRun | null;
  /** Opt in: open a `driver ↔ designer` loop carrying the run's ceilings and enter queue mode. A no-op
   *  when a run is already active, or when `bsc loop new` fails (the bridge/binary is absent) — a run
   *  without a real loop behind it would drive nothing, so we stay OFF rather than pretend. */
  startDesignerOvernight: (opts?: { maxTurns?: number; budget?: number }) => Promise<void>;
  /** Ask the run to halt: flag it `stopping` (which stops the pump dispatching on its very next read)
   *  and issue the out-of-band `bsc loop stop`. The local run state is NOT cleared here — the pump
   *  clears it via {@link endDesignerOvernight} once the loop is observably gone, and re-issues the
   *  stop each tick until then, so a swallowed CLI failure retries instead of stranding a live loop. */
  stopDesignerOvernight: () => Promise<void>;
  /** Leave overnight mode locally (the pump, once its loop is confirmed closed/absent). */
  endDesignerOvernight: () => void;
  /** Install the ranked directive queue built once at run start (`buildDesignerQueue`). */
  setDesignerOvernightQueue: (queue: DesignDirective[]) => void;
  /** Advance the queue cursor — one dispatched directive (the cursor IS the turn count). */
  advanceDesignerOvernight: () => void;
}

/** A live overnight run's state. The ceilings are mirrored from the ones handed to `bsc loop new`, so
 *  the pump stops dispatching at the same point the loop store would independently close the loop. */
export interface DesignerOvernightRun {
  /** The `bsc loop` this run drives — the pump ignores any other open loop. */
  loopId: number;
  /** Directive ceiling: the pump stops once `cursor` reaches it (see `decideOvernightAction`). */
  maxTurns: number;
  /** Cost ceiling in USD handed to `bsc loop --budget` (0 = unlimited). */
  budget: number;
  /** Directives dispatched so far — the queue cursor AND the turn count. */
  cursor: number;
  /** The ranked queue, built once at run start so `queue[cursor]` stays stable as findings are fixed. */
  queue: DesignDirective[];
  /** A halt has been requested — dispatch nothing; keep re-issuing `bsc loop stop` until it lands. */
  stopping: boolean;
  startedAt: number;
}

/** The default cost ceiling handed to `bsc loop --budget`. HONEST CAVEAT: the loop store sums the
 *  per-turn `--cost` values, and only the designer can report what its own turn cost — so this bites
 *  only when turns actually carry `--cost`. {@link DEFAULT_MAX_TURNS} is the ceiling that always
 *  applies, which is why it is passed unconditionally. */
export const DEFAULT_OVERNIGHT_BUDGET = 10;

/** The seed the overnight loop opens with — the driver speaks first, so this is context, not a task. */
const OVERNIGHT_SEED =
  "Overnight design run: the driver dispatches one ranked directive per turn from the design system's own " +
  "measured gaps. Make ONE change per turn via `bsc ui`, ground it with a fresh `bsc shot`, and record it.";

export const createComponentsSlice: StateCreator<AppStore, [], [], ComponentsSlice> = (set, get) => ({
  components: SEED_COMPONENTS,
  kits: SEED_KITS,

  hydrateComponents: async () => {
    // #2975: auto-apply ON ⇒ no pending review queue. `kitDispatches` is persisted (durable across
    // restarts), so drop any queued requests on boot when the setting is enabled — they're ignored.
    if (get().autoApplyKitChanges && get().kitDispatches.length > 0) set({ kitDispatches: [] });
    // ── PHASE 1 (#4072): paint from the GRAPH projection ────────────────────────────────────────
    // `--full` is 1.72 MB over 321 components and measured up to 8040ms, which is what the Studio
    // page blocked on; the projection is 33 KB. Rendering the graph needs nothing else, so set the
    // records and let the page paint while phase 2 runs.
    //
    // NO reconcile here, deliberately. `reconcileComponents` decides which built-ins are stale and
    // PUSHES the fixed copies back to the store — fed lite records it would write their empty
    // `srcText` over real source. Phase 1 only ever sets state; phase 2 owns convergence.
    const graph = await loadComponentsGraph();
    if (graph?.length) set({ components: graph });
    // ── PHASE 2: the full-fidelity read, off the critical path ──────────────────────────────────
    const [loadedC, loadedK] = await Promise.all([loadComponents(), loadKits()]);
    // Compile each KIT's MOTION library (#2942) into the managed <style> — on boot (useAppBoot calls
    // this) and on a `ui-touch` write (setAiFocused re-runs it), mirroring the variant apply.
    if (!loadedC && !loadedK) { applyAnimationsToRoot(kitAnimations(get().kits)); return; } // seed
    const rc = reconcileComponents(loadedC ?? []);
    const rk = reconcileKits(loadedK ?? []);
    // Replace only OUR notice types — theme notices (#2488) belong to hydrateThemes, which may have
    // already run (the two hydrates race on boot).
    set((s) => ({
      components: rc.records,
      kits: rk.records,
      seedNotices: [...s.seedNotices.filter((n) => n.type === "theme"), ...rk.notices, ...rc.notices],
    }));
    applyAnimationsToRoot(kitAnimations(rk.records));
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

  designContributions: [],
  addDesignContribution: (overlay) =>
    set((s) => {
      const next = [...s.designContributions.filter((o) => o.source !== overlay.source), overlay];
      applyContributionsToRoot(next);
      return { designContributions: next };
    }),
  removeDesignContribution: (source) =>
    set((s) => {
      const next = s.designContributions.filter((o) => o.source !== source);
      applyContributionsToRoot(next);
      return { designContributions: next };
    }),

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
  autoApplyKitChanges: true, // #2968: default ON — designer changes apply without confirmation; toggle OFF in Planner settings to gate them
  setAutoApplyKitChanges: (on) =>
    // #2975: enabling auto-apply IGNORES the pending review queue — drop the queued requests so they
    // don't linger (the banner already hides when ON; this also stops the drain re-delivering them).
    set((s) => ({ autoApplyKitChanges: on, kitDispatches: on ? [] : s.kitDispatches })),
  dismissKitChange: (changeId) =>
    set((s) => ({ kitDispatches: s.kitDispatches.filter((d) => d.change.id !== changeId) })),

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
    if (dispatches.length) set((s) => ({ kitDispatches: mergeDispatches(s.kitDispatches, dispatches) }));
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

  // #3274: empty kit ⇒ the workbench falls back to the first kit (matching the old lazy useState);
  // null component ⇒ Inspector hidden-when-empty (#3090). Neither is persisted.
  designsKitId: "",
  designsCompId: null,
  setDesignsKit: (id) => set({ designsKitId: id, designsCompId: null }),
  setDesignsComp: (id) => set({ designsCompId: id }),
  designsPreviewState: "loaded",
  setDesignsPreviewState: (s) => set({ designsPreviewState: s }),

  aiFocusedId: null,

  setAiFocused: (id, collection, opts) => {
    set({ aiFocusedId: id });
    if (!id) return; // a clear (session end) — no re-pull
    // #3545: a READ-focus (`ui-focus`) drives the preview only — nothing changed, and this fires on every
    // `get`, so a re-hydrate here would refetch the whole library every ~1.5s poll. Writes still hydrate.
    if (opts?.hydrate === false) return;
    // Re-hydrate the touched collection so the AI's edit shows without a relaunch (#2483/#2514/#2525).
    // A designer session edits via the CLI (`bsc ui set` / `set-token` / `define-variant`), which lands
    // here as a `ui-touch` — the desktop `setComponent` fan-out never runs for it. So DIFF the reloaded
    // library against the pre-hydration snapshot and fan out each component whose contract changed, so a
    // CLI edit propagates exactly like a desktop edit (#2810). Deduped by `dispatchKey`.
    const before = get().components;
    // `Promise.resolve(...)` so a test that stubs `hydrateComponents` with a plain `vi.fn()` (returns
    // undefined, not a promise) doesn't throw on `.then` — the diff simply sees no change.
    void Promise.resolve(get().hydrateComponents()).then(() => {
      const s = get();
      const fresh = s.components.flatMap((after) => {
        const b = before.find((x) => x.id === after.id);
        return b && contractChanged(b, after) ? planPropagation(makeChange(after, b), s.kitUsage) : [];
      });
      if (fresh.length) set((st) => ({ kitDispatches: mergeDispatches(st.kitDispatches, fresh) }));
    });
    if (collection === "theme") void get().hydrateThemes();
    if (collection === "variant") void get().hydrateVariants();
  },

  componentBuildStatus: {},

  setComponentBuildStatus: (id, status) =>
    set((s) => ({ componentBuildStatus: { ...s.componentBuildStatus, [id]: status } })),

  componentStateHealth: {},

  setComponentStateHealth: (id, categories) =>
    set((s) => ({ componentStateHealth: { ...s.componentStateHealth, [id]: categories } })),

  designerOvernight: null,

  startDesignerOvernight: async (opts) => {
    if (get().designerOvernight) return; // never stack two runs onto one designer session
    const maxTurns = Math.max(1, Math.trunc(opts?.maxTurns ?? DEFAULT_MAX_TURNS));
    const budget = Math.max(0, opts?.budget ?? DEFAULT_OVERNIGHT_BUDGET);
    // The ceilings go to the LOOP STORE too, which enforces them inside `say` — a DURABLE backstop that
    // outlives this process: if the app is killed mid-run, the loop still closes itself once the ceiling
    // is hit, and a closed loop rejects every further turn. The store-side turn cap is deliberately
    // LOOSER than the pump's (`maxTurns` counts DIRECTIVES; the loop counts every turn, driver AND
    // designer — so ~2 per directive), because the pump should be what stops a healthy run; the store
    // ceiling is the net under it, not the thing that fires first.
    const args = [
      "loop", "new", DRIVER, DESIGNER,
      "--seed", OVERNIGHT_SEED,
      "--until", "false",
      "--max-turns", String(maxTurns * 2 + 2),
    ];
    if (budget > 0) args.push("--budget", String(budget));
    let loopId: number | null;
    try {
      const printed = (await bsc(null, args)).trim().match(/\d+/); // `bsc loop new` prints the new id
      loopId = printed ? Number(printed[0]) : null;
    } catch {
      loopId = null; // bridge/binary absent
    }
    if (loopId === null || !Number.isFinite(loopId)) return; // stay OFF rather than fake a run
    set({ designerOvernight: { loopId, maxTurns, budget, cursor: 0, queue: [], stopping: false, startedAt: Date.now() } });
  },

  stopDesignerOvernight: async () => {
    const run = get().designerOvernight;
    if (!run) return;
    set({ designerOvernight: { ...run, stopping: true } }); // halts dispatch before the CLI round-trip
    await bscRun(null, ["loop", "stop", String(run.loopId)]);
  },

  endDesignerOvernight: () => set({ designerOvernight: null }),

  setDesignerOvernightQueue: (queue) =>
    set((s) => (s.designerOvernight ? { designerOvernight: { ...s.designerOvernight, queue } } : {})),

  advanceDesignerOvernight: () =>
    set((s) => (s.designerOvernight ? { designerOvernight: { ...s.designerOvernight, cursor: s.designerOvernight.cursor + 1 } } : {})),
});
