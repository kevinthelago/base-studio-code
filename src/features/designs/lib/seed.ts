// The packaged Component Library seed (#2269) — reset to a CLEAN SLATE (#3543): a single EMPTY kit,
// `base-studio-code`. The designer session fills it (components + all algorithm animations + everything
// needed to create/run the app) via `bsc ui`, and the studio command exports it. This is the concrete
// first move toward "the app's own entire UI as one graph" (endpoint of #3451).
//
// What this replaced: six separately-seeded kits — `react-ui` (generated primitives, gated off #3029),
// `fleet` (#3462), `base` motion (#3451), and the three viz kits (#3194/#3242). Their per-kit assemblers
// were deleted with this change. IMPORTANT: the algorithm-viz MOTION still lives in the shared
// `*_VIZ_ANIMATIONS` consts under `shared/ui/kit/` — the Algorithms graph renderers compile from those
// DIRECTLY, independent of the design kits, so wiping the design library does NOT touch the Algorithms
// feature. The `react-ui.json` artifact is likewise untouched (still consumed by the released-kit store,
// the preview raw-import, and the manifest drift guard).
//
// The wipe: on the next launch `hydrateComponents` reconciles the store toward this seed. Every prior
// PRISTINE packaged kit LEFT the seed, so the #2483 refresh DROPS it (from `app-state.json` and the
// on-disk `bsc` store); the empty `base-studio-code` kit is seeded in its place. (A hand-edited builtin
// is kept with an `orphaned` notice — the designer can delete it, or a hard reset can force-clear.)
import type { ComponentRecord, Kit } from "./model";
import { projectComponent } from "./componentBridge";
import { reconcileSeed, stampSeedHash, type SeedReconcile } from "./seedRefresh";

/** The one packaged kit id — the base-studio-code app's own UI as a single graph (#3543). */
export const BASE_STUDIO_CODE_KIT_ID = "base-studio-code";

/** The single EMPTY packaged kit. No components, no animations — the designer session fills it and the
 *  studio command exports it. `tech: "react"` is load-bearing: packaged themes bind to the design group
 *  by `tech` (never kit id), so keeping it "react" preserves every theme. */
const baseStudioCodeKit: Kit = stampSeedHash({
  id: BASE_STUDIO_CODE_KIT_ID,
  name: "base-studio-code",
  tech: "react",
  style: "studio",
  stack: "base-studio-code",
  dot: "var(--accent)",
  animations: [],
  builtin: true,
});

/** The packaged built-in kits — one empty `base-studio-code` kit (#3543). Enumerated by the stamping +
 *  round-trip drift guards. */
export const SEED_KITS: Kit[] = [baseStudioCodeKit];

// The migrated app-page components — the app's own UI authored as graph source under
// `src-tauri/data/components/app/**` (#3604, moving the code UI into the one `base-studio-code` graph).
// Vite-glob-imported (eager) so a newly-migrated page is PACKAGED simply by dropping its `.json` there,
// no seed edit. Each row runs through the SAME `projectComponent` load projection + is stamped
// `builtin`/`seedHash`, so `seed === load(push(seed))` (the #2514 round-trip) holds BY CONSTRUCTION and
// the #2483 reconcile seeds it on first run + tracks it release-to-release.
const migratedApp = import.meta.glob<Partial<ComponentRecord>>("@data/components/app/**/*.json", {
  eager: true,
  import: "default",
});

/** The packaged built-in components — the migrated app pages (#3604); the `base-studio-code` kit fills as
 *  the code UI moves into the graph. Empty until the first page migrated (fleetpage, #3606). */
export const SEED_COMPONENTS: ComponentRecord[] = Object.keys(migratedApp)
  .sort() // deterministic order — glob key order is filesystem-dependent
  .map((path) => stampSeedHash({ ...projectComponent(migratedApp[path]), builtin: true }));

/**
 * Reconcile the store's loaded components with the packaged built-ins (#2483, hash-based refresh — the
 * full verdict table lives on {@link reconcileSeed}): a PRISTINE built-in copy (its content still hashes
 * to its stamped `seedHash`; a legacy no-hash copy counts as pristine) tracks the seed — refreshed when
 * the seed changed, deleted when the built-in left the seed. A USER-EDITED built-in is always kept (store
 * wins), with a notice when the seed diverged. User-authored records are never touched; built-ins the
 * store lacks are re-added. `hydrateComponents` applies the pushes/drops so the store converges.
 *
 * With the seed now empty (#3543), this DROPS every prior pristine packaged component on the next boot.
 */
export function reconcileComponents(loaded: ComponentRecord[]): SeedReconcile<ComponentRecord> {
  return reconcileSeed(loaded, SEED_COMPONENTS, "component");
}

/** Reconcile loaded kits with the packaged built-in kits (see {@link reconcileComponents}). Drops every
 *  prior pristine packaged kit and seeds the one empty `base-studio-code` kit (#3543). */
export function reconcileKits(loaded: Kit[]): SeedReconcile<Kit> {
  return reconcileSeed(loaded, SEED_KITS, "kit");
}
