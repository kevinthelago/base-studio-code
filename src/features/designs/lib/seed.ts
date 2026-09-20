// The packaged Component Library seed (#2269) — reset to a CLEAN SLATE (#3543): a single EMPTY kit,
// `base-studio-code`. The designer session fills it (components + all algorithm animations + everything
// needed to create/run the app) via `bsc components`, and the studio command exports it. This is the concrete
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
import type { ComponentRecord, Kit } from "@/features/designs/lib/model";
import { projectComponent } from "./componentBridge";
import { planRestamp, reconcileSeed, stampSeedHash, type RestampPlan, type SeedReconcile } from "@/features/designs/lib/seedRefresh";

/** The one packaged kit id — the base-studio-code app's own UI as a single graph (#3543). */
export const BASE_STUDIO_CODE_KIT_ID = "base-studio-code";

/** The single packaged kit — the app's own UI as one graph. `tech: "react"` is load-bearing: packaged
 *  themes bind to the design group by `tech` (never kit id), so keeping it "react" preserves every theme.
 *  `style` is the Components-rail GROUP label; it is deliberately the kit's own name (NOT "studio", which
 *  would collide with the "Studio" app-library snapshot concept — bsc-studio — and confuse users, #3640). */
const baseStudioCodeKit: Kit = stampSeedHash({
  id: BASE_STUDIO_CODE_KIT_ID,
  name: "base-studio-code",
  tech: "react",
  style: "base-studio-code",
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
  // STORE ALWAYS WINS. The seed is the app's STARTING POINT — what a fresh install boots from and what a
  // release ships — not a standing authority over a running app. Everything after first run is in-app, so
  // no class of record is force-reset from the seed.
  //
  // This drops the `seedAuthoritative: role === "page"` predicate #3723 added. That predicate is why a
  // page's store copy was forced back to the seed, and it is what silently deleted the moved tests from
  // `consolepage`/`projectspage` seconds after they were written. Every other role already worked this
  // way — a USER-EDITED built-in was always kept — so this makes the rule uniform rather than inventing one.
  //
  // A PRISTINE copy still tracks the seed (that is content-hash based, not role based), so a fresh install
  // still seeds and a release still refreshes records nobody has touched. Only an EDITED record now
  // survives unconditionally.
  //
  // What this gives up: #3723's guard against a self-contained page record shadowing the shipped app. With
  // no automatic reset, the app renders what the store holds — so recovery is the store's history plus the
  // committed seed. `stamp_with_history` records WHICH fields changed, never their prior VALUES, so until
  // history carries content the seed in git is the only true restore path.
  return reconcileSeed(loaded, SEED_COMPONENTS, "component");
}

/**
 * Plan the `unstamped` repair for components (#4207 — the rule and why the stamp carries the SEED's hash
 * live on {@link planRestamp}). Passes no `seedAuthoritative` predicate, matching {@link reconcileComponents}
 * under store-always-wins: with the seed no longer authoritative for any role there is nothing to DEFER,
 * so an unstamped page is repaired like any other record.
 *
 * The two must stay in lockstep. The predicate previously deferred pages precisely because reconcile would
 * have force-reset them; a stamp there would have handed the seed copy over the store copy the app renders.
 * Now that reconcile keeps an edited record, stamping one is a provenance repair, not a content swap.
 */
export function planComponentRestamp(loaded: ComponentRecord[]): RestampPlan<ComponentRecord> {
  return planRestamp(loaded, SEED_COMPONENTS);
}

/** Reconcile loaded kits with the packaged built-in kits (see {@link reconcileComponents}). Drops every
 *  prior pristine packaged kit and seeds the one empty `base-studio-code` kit (#3543). */
export function reconcileKits(loaded: Kit[]): SeedReconcile<Kit> {
  return reconcileSeed(loaded, SEED_KITS, "kit");
}
