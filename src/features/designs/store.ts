// Components feature store slice (#2269) — the proven-component library, a WRITE-THROUGH cache over the
// GLOBAL component store (reached via `bsc ui` — see lib/componentBridge.ts, #2281). The planner's
// `test_ui` pane and (later) the full Design Studio page share ONE library. On boot `hydrateComponents`
// loads both collections through the bridge and reconciles the packaged built-ins with the hash-based
// seed refresh (#2483, lib/seedRefresh.ts): pristine built-in copies track the seed (refreshed/deleted),
// user-edited ones are kept with a notice, and missing built-ins are re-seeded. A no-op that keeps the
// seed when the bridge is unreachable (tests, the web shell, an old bundled `bsc`).
import type { StateCreator } from "zustand";
import type { AppStore } from "@/store/types";
import type { ComponentRecord, Kit } from "@/features/designs/lib/model";
import type { ComponentBuildStatus, RuntimeStateCategory, ComponentScanResult } from "@/features/designs/lib/componentScan";
import type { PreviewState } from "./lib/componentPreview";
import type { KitConsumer, KitChange, Dispatch } from "@/features/designs/lib/propagation";
import type { SeedNotice } from "@/features/designs/lib/seedRefresh";
import { kitUsageId, makeChange, planPropagation, dispatchKey } from "@/features/designs/lib/propagation";
import { SEED_COMPONENTS, SEED_KITS, planComponentRestamp, reconcileComponents, reconcileKits } from "./lib/seed";
import { applyStamps } from "@/features/designs/lib/seedRefresh";
import { SEED_THEMES, reconcileThemes, orderThemes, type KitThemeRecord } from "@/features/designs/lib/themes";
import { loadComponents, loadComponentsGraph, loadKits, pushComponent, stampComponent, dropComponent, pushKit, dropKit } from "./lib/componentBridge";
import { loadThemes, pushTheme, dropTheme, loadVariants } from "@/features/designs/lib/themeBridge";
import { loadKitUsage, pushKitUsage, dropKitUsage } from "@/features/designs/lib/kitUsageBridge";
import { setActiveKitThemes, applyVariantsToRoot, applyContributionsToRoot, applyAnimationsToRoot, kitAnimations, type DesignContributionOverlay } from "@/shared/ui/kit";

/** One observed designer activity event (#2525) — a ring entry in {@link AppStore.aiTouches}.
 *  Mirrors the `UiTouch` the `ui-activity` parser produces; declared here so the slice does not import
 *  the hook (which pulls in React) just for a shape. */
export interface AiTouch {
  /** `"touch"` = a WRITE (`bsc ui set/remove`) → focus + re-hydrate; `"focus"` = a READ (`bsc ui get`,
   *  #3545) → focus only, nothing changed to reload. */
  kind: "touch" | "focus";
  /** The touched store collection — `component` · `kit` · `theme` · `variant`. */
  collection: string;
  /** The record id written/removed/read. */
  id: string;
  /** The kit the record belongs to, when the emitter reported it (the activity line's 6th column).
   *  Absent on a legacy 5-column line, in which case the kit is resolved from the store instead. */
  kitId?: string;
  /** The emitting pane (`$BSC_AUDIT_PANE`, or `?`). */
  pane: string;
  /** Epoch-ms of the event (0 when the log's timestamp was unparseable). */
  at: number;
}

/** How many touches the ring keeps. Sized for the strip: enough that a burst leaves a readable trail,
 *  short enough that the oldest row is still plausibly "what is happening now". */
export const AI_RING_MAX = 8;

/** Fold `fresh` (oldest-first) into `ring` (newest-first), newest first and capped at {@link AI_RING_MAX}.
 *  Pure + exported for the unit test. */
export function foldTouches(ring: AiTouch[], fresh: AiTouch[]): AiTouch[] {
  return [...fresh].reverse().concat(ring).slice(0, AI_RING_MAX);
}

/** May this touch take the focus? Only a touch on a component in the kit already on screen.
 *
 *  The kit is the ONLY condition, deliberately. An age cut-off was considered — the poll's first tick
 *  replays up to 50 lines of history, so a fresh mount focuses the newest PAST touch — but that was
 *  already the behaviour before this change, focusing the most recent work when the Studio opens is
 *  reasonable, and adding a cut-off would change when focus happens beyond what was asked for.
 *
 *  The kit is read from the EMITTER's own column first (the activity line's 6th): a record written
 *  moments ago may not be in `components` yet, so resolving from the store would miss exactly the
 *  newest work. A legacy 5-column line falls back to the store.
 *
 *  A touch whose kit resolves NEITHER way is not focusable — that is a #3725 tombstone from `bsc ui
 *  merge`/`suppress`, a retired id with no record behind it. It still enters the ring (it happened and
 *  the trail should show it), but there is nothing on screen to focus, and writing it to `aiFocusedId`
 *  would blank the Inspector for exactly the same reason a cross-kit id does. */
export function focusable(t: AiTouch, get: () => AppStore): boolean {
  const s = get();
  const kitId = t.kitId || s.components.find((c) => c.id === t.id)?.kitId;
  // Mirrors the workbench's own fallback (`storedKitId || kits[0]?.id`), so "the kit on screen" means
  // the same thing here as it does there — an empty `designsKitId` still shows the first kit.
  return !!kitId && kitId === (s.designsKitId || s.kits[0]?.id || "");
}

/** How long a burst of writes is allowed to accumulate before ONE re-hydrate runs. Long enough that a
 *  fleet writing several records a second collapses to a single reload, short enough that a lone edit
 *  still appears promptly. Exported so a test can drive the window rather than guess it. */
export const AI_HYDRATE_DEBOUNCE_MS = 600;

/** The pending coalesced re-hydrate. Module-scoped rather than per-store because it guards a real
 *  side effect (a 590-record reload) that must not run N times for N touches; `setAiFocused(null)` on
 *  unmount does not cancel it deliberately — a write that already happened still needs loading. */
let aiHydrateTimer: ReturnType<typeof setTimeout> | null = null;
const aiHydratePending = new Set<string>();

/** The narrow view of zustand's `get`/`set` these module-level helpers need. */
type SliceGet = () => AppStore;
type SliceSet = (partial: Partial<AppStore> | ((s: AppStore) => Partial<AppStore>)) => void;

/** Debounce a re-hydrate over the union of the collections touched in the window. */
function scheduleAiHydrate(collections: string[], run: (cols: Set<string>) => void): void {
  for (const c of collections) aiHydratePending.add(c);
  if (aiHydrateTimer) clearTimeout(aiHydrateTimer);
  aiHydrateTimer = setTimeout(() => {
    aiHydrateTimer = null;
    const cols = new Set(aiHydratePending);
    aiHydratePending.clear();
    run(cols);
  }, AI_HYDRATE_DEBOUNCE_MS);
}

/**
 * Re-pull the touched collections so the AI's edit appears without a relaunch (#2483/#2514/#2525).
 *
 * A designer session edits via the CLI (`bsc ui set` / `set-token` / `define-variant`), which lands as
 * a `ui-touch` — the desktop `setComponent` fan-out never runs for it. So DIFF the reloaded library
 * against the pre-hydration snapshot and fan out each component whose contract changed, so a CLI edit
 * propagates exactly like a desktop edit (#2810). Deduped by `dispatchKey`.
 */
function runAiHydrate(get: SliceGet, set: SliceSet, collections: Set<string>): void {
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
  if (collections.has("theme")) void get().hydrateThemes();
  if (collections.has("variant")) void get().hydrateVariants();
}

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
  /** Repair the `unstamped` records (#4207): re-stamp every store copy that a packaged seed exists for
   *  but which carries no `builtin` flag, so it rejoins the reconcile path. NON-DESTRUCTIVE — content is
   *  untouched and the stamp carries the SEED's hash, which reads as "edited, seed unchanged" and keeps
   *  the store copy (see `planRestamp`). `role: page` records are deferred, never stamped. Resolves to
   *  the counts so the caller can report what happened. */
  restampUnstamped: () => Promise<{ stamped: number; deferred: number }>;

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

  /** The recent designer activity RING (#live-focus-is-kit-filtered) — newest FIRST, bounded to
   *  {@link AI_RING_MAX}. Each entry is one `ui-touch`/`ui-focus` the `useUiActivity` poll observed.
   *
   *  This replaced a single `aiFocusedId` scalar, which structurally could not represent CONCURRENT
   *  work: N designer sessions collapsed to last-writer-wins, and two touches inside one poll window
   *  meant one was never displayed at all. A ring is what makes a fast burst legible — the strip reads
   *  as a list, and the graph pulses every node in it with intensity decaying by age. TRANSIENT. */
  aiTouches: AiTouch[];
  /** The ring HEAD's id — the node the designer AI is most recently on (#2525). Kept as its own field
   *  because everything downstream (the `.working` pulse, the auto-pan, the Inspector's fallback
   *  subject) already reads it. `null` when the ring is empty or the session ended. */
  aiFocusedId: string | null;
  /** Fold freshly-observed touches (OLDEST-first, as the log is read) into the ring (#2525).
   *
   *  Beyond the ring it does two things the old per-touch path could not:
   *  - **Focuses an IN-KIT touch**, selected or not, so the node the designer just wrote is the one on
   *    screen. A touch in another kit is ignored entirely — no kit switch, no pan, no selection change.
   *    Crucially it is ignored by NOT WRITING `aiFocusedId`, since writing an id this graph does not
   *    contain is what used to empty the Inspector.
   *  - **Coalesces the re-hydrate**: a burst of N writes costs ONE library reload, not N. Focus still
   *    lands immediately; only the reload waits.
   *
   *  `opts.hydrate: false` folds the touches into the ring WITHOUT scheduling a reload — the poll's
   *  priming tick, which is replaying history the boot hydrate already loaded. */
  pushAiTouches: (touches: AiTouch[], opts?: { hydrate?: boolean }) => void;
  /** Live-focus ONE node (#2525) — the single-touch path, kept for the clear-on-unmount call
   *  (`setAiFocused(null)`, which also empties the ring) and as the narrow entry point tests drive.
   *  `opts.hydrate` (default true) re-pulls the collection so a WRITE's edit shows; a READ-focus
   *  (#3545 `ui-focus`) passes `false` — the preview follows Claude's inspection without a library
   *  refetch on every `get`. */
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

  /** Apply a BATCH of scan results in ONE commit (#4132) — the scan's real write path.
   *
   *  The two per-result setters above wrote twice per component, so a 248-component sweep produced ~496
   *  store commits, and the Studio (which subscribes to both maps) re-rendered its whole graph on each
   *  one — the measured churn was 125 `[render] designs update` commits at ~24ms. Both maps move together
   *  in a single `set` so a flush is one commit and one render, whatever its size. An empty batch is a
   *  no-op rather than an identity-breaking commit. */
  applyComponentScanResults: (results: readonly ComponentScanResult[]) => void;

}

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
    // COLD STORE ONLY (#the-fast-paint-phase-remounts-every-page-on-every-rehydrate).
    //
    // Phase 1 blanks `srcText` on every record — the lite projection carries none. That is harmless on
    // a cold store (there is nothing to blank) and destructive on a RE-hydrate: every `GraphComponent`
    // selects `srcText`, so each page goes real → "" → real, dropping to its fallback — which unmounts
    // its whole subtree — and RECOMPILING when phase 2 restores the source.
    //
    // The console page is one of those pages and it holds the terminal, so the remount destroys and
    // recreates the xterm instance. Measured in the app log as `compile #2 "consolepage"` firing minutes
    // apart with no page load anywhere near it; felt by the user as focus being taken away mid-keystroke.
    // `useUiActivity` re-runs this hydrate on every `ui-touch`, so a designer working normally triggers
    // it continuously.
    //
    // The optimisation is worth keeping exactly where it pays: a cold store blocks up to 8s on `--full`.
    // Once full records are in hand there is nothing left to optimise, and the fast path costs a remount
    // while buying nothing. `lite` is the discriminator the projection already stamps.
    if (!get().components.some((c) => !c.lite)) {
      const graph = await loadComponentsGraph();
      if (graph?.length) set({ components: graph });
    }
    // ── PHASE 2: the full-fidelity read, off the critical path ──────────────────────────────────
    const [loadedC, loadedK] = await Promise.all([loadComponents(), loadKits()]);
    // Compile each KIT's MOTION library (#2942) into the managed <style> — on boot (useAppBoot calls
    // this) and on a `ui-touch` write (setAiFocused re-runs it), mirroring the variant apply.
    if (!loadedC && !loadedK) { applyAnimationsToRoot(kitAnimations(get().kits)); return; } // seed
    // PROVENANCE REPAIR, before the reconcile (#auto-restamp-unstamped). A record whose `builtin` flag
    // was lost — or, far more often here, one whose store copy predates the packaged seed that was later
    // created for its id — sits OUTSIDE the reconcile: it never refreshes and never reports drift, while
    // the app renders it. Repairing it is not a judgement call: `planRestamp` stamps with the SEED's
    // hash, so the record reads as edited-against-an-unmoved-seed, the verdict that KEEPS the store copy.
    // It restores MEMBERSHIP without adjudicating content, which is why it no longer needs a click.
    //
    // Stamped in place and fed straight to the reconcile, rather than written and re-read: a re-hydrate
    // from inside `hydrateComponents` would re-enter itself.
    const restamp = planComponentRestamp(loadedC ?? []);
    // `stampComponent` merges ONLY the two stamp fields. `pushComponent` would send the whole record and
    // drop whatever this projection does not carry — the #4197 failure, committed by the repair for it.
    for (const c of restamp.stamps) void stampComponent(c.id, c.seedHash!);
    const rc = reconcileComponents(applyStamps(loadedC ?? [], restamp.stamps));
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
    //
    // GUARDED BY THE REV WE READ (#a-stale-app-copy-overwrites-a-designer-edit). This converge writes
    // records the app did not author, from a snapshot taken at the top of this function — so anything
    // written to the store between that read and here is silently destroyed by the push. That is exactly
    // what happened to a designer's `srcText` fix: read pre-edit, edited out of band, converged back 23
    // minutes later. The guard is the rev from THIS load, so a store that moved refuses the write and the
    // next hydrate picks up the newer copy instead. A record the store lacks has no prior rev to name and
    // is written unguarded, as before.
    const revById = new Map((loadedC ?? []).map((c) => [c.id, c.rev]));
    for (const c of rc.pushes) void pushComponent(c, { ifVersion: revById.get(c.id) });
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

  restampUnstamped: async () => {
    // Plan against the STORE's records, not `get().components` — phase 1 of `hydrateComponents` paints
    // from the lite graph projection, whose `srcText` is empty. Stamping from that would push a record
    // whose hash describes content the store does not hold, and the very next reconcile would read the
    // record as edited against its own stamp. Re-read at full fidelity.
    const loaded = await loadComponents();
    if (!loaded) return { stamped: 0, deferred: 0 }; // bridge unreachable — nothing to repair against
    const plan = planComponentRestamp(loaded);
    // `stampComponent`, not `pushComponent`: a MERGE of the two stamp fields. These records were READ
    // from the store, so writing them back with `--replace` would push the bridge projection over the
    // stored record and drop whatever the projection does not carry — the #4197 failure, committed by
    // the very pass meant to repair its damage.
    for (const c of plan.stamps) await stampComponent(c.id, c.seedHash!);
    // Re-hydrate rather than patching state by hand: the stamped records now take a DIFFERENT branch of
    // the reconcile, and its verdicts (including which notices survive) are the thing being repaired.
    if (plan.stamps.length > 0) await get().hydrateComponents();
    return { stamped: plan.stamps.length, deferred: plan.deferred.length };
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
  /**
   * IDEMPOTENT — re-selecting the component that is already selected must not notify.
   *
   * `set({ designsCompId: id })` builds a new state object every call, so Zustand notified every
   * subscriber even when the id had not changed. Clicking the already-selected node in the Design
   * Studio therefore re-rendered the whole workbench for no change: MEASURED at 103-150 ms per repeat
   * click, with commits, on a graph where the click itself now does nothing.
   *
   * Returning the SAME state object is what makes Zustand skip the notification — a `===` check on the
   * value is not enough, the object identity is what it compares. Deliberately NOT applied to
   * `setDesignsKit`, which also clears the component: an early return there would change behaviour for
   * a caller that relies on that clear, and it is not on this hot path (`selectComp` already guards it
   * behind `c.kitId !== kitId`).
   */
  setDesignsComp: (id) => set((s) => (s.designsCompId === id ? s : { designsCompId: id })),
  designsPreviewState: "loaded",
  setDesignsPreviewState: (s) => set({ designsPreviewState: s }),

  aiTouches: [],
  aiFocusedId: null,

  pushAiTouches: (touches, opts) => {
    if (!touches.length) return;
    const ring = foldTouches(get().aiTouches, touches);
    const head = ring[0];

    // ── Focus an IN-KIT touch; ignore a cross-kit one outright ─────────────────────────────────
    // (#auto-focus-in-kit-and-drop-the-activity-pills.) A touch on a component in the kit already on
    // screen focuses it, whether or not something is selected — a brief focus is the intended
    // behaviour, not a disruption to guard against. A touch in ANOTHER kit does nothing at all: no kit
    // switch, no pan, no selection change.
    //
    // This replaces an auto-FOLLOW that switched kits while nothing was selected, and a strip of chips
    // added to recover the signal that gate suppressed. The gate cited #3599/#4248, which govern `bsc
    // navigate` yanking a user to a different PAGE — their own test draws the line at "sets the focus
    // but does NOT yank the user off their current page", so setting focus was never what they
    // refused. Not following also removes a hazard the old gate only half-covered: `setDesignsKit`
    // CLEARS `designsCompId`, so a cross-kit follow could cost the user their place mid-edit.
    //
    // IGNORED MEANS NOT WRITTEN, never written-and-hidden. Setting `aiFocusedId` to an id this graph
    // does not contain is the original blank-page defect: the Studio filters the pulse, the pan AND the
    // Inspector subject by kit, so an out-of-kit head made `aiComp` null and EMPTIED the Inspector —
    // and measured over 200 touches the fleet spanned three kits, so that was the COMMON case. Leaving
    // the previous value alone keeps the last in-kit subject on screen instead.
    const keepFocus = !!head && head.collection === "component" && !focusable(head, get);
    set(keepFocus ? { aiTouches: ring } : { aiTouches: ring, aiFocusedId: head?.id ?? null });

    // ── Coalesce the re-hydrate ────────────────────────────────────────────────────────────────
    // Every WRITE used to reload the whole library, reconcile it and re-diff it for propagation —
    // ~590 records, several times a minute under a live fleet. A burst now costs one reload. READ
    // focuses (#3545 `ui-focus`) still reload nothing: they changed nothing.
    const writes = opts?.hydrate === false ? [] : touches.filter((t) => t.kind === "touch");
    if (writes.length) scheduleAiHydrate(writes.map((t) => t.collection), (cols) => runAiHydrate(get, set, cols));
  },

  setAiFocused: (id, collection, opts) => {
    // A clear (session end / Studio unmount) empties the RING too — otherwise the strip would keep
    // showing a finished session's work as though it were live.
    if (!id) { set({ aiFocusedId: null, aiTouches: [] }); return; }
    set({ aiFocusedId: id });
    // #3545: a READ-focus (`ui-focus`) drives the preview only — nothing changed, and this fires on every
    // `get`, so a re-hydrate here would refetch the whole library every ~1.5s poll. Writes still hydrate.
    if (opts?.hydrate === false) return;
    runAiHydrate(get, set, new Set(collection ? [collection] : []));
  },

  componentBuildStatus: {},

  setComponentBuildStatus: (id, status) =>
    set((s) => ({ componentBuildStatus: { ...s.componentBuildStatus, [id]: status } })),

  componentStateHealth: {},

  setComponentStateHealth: (id, categories) =>
    set((s) => ({ componentStateHealth: { ...s.componentStateHealth, [id]: categories } })),

  applyComponentScanResults: (results) => {
    if (results.length === 0) return; // never commit an empty flush
    set((s) => {
      const componentBuildStatus = { ...s.componentBuildStatus };
      const componentStateHealth = { ...s.componentStateHealth };
      for (const r of results) {
        componentBuildStatus[r.id] = r.status;
        componentStateHealth[r.id] = r.stateBlanks;
      }
      return { componentBuildStatus, componentStateHealth };
    });
  },

});
