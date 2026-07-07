// The packaged Component Library (#2269), loaded from `src-tauri/data/components/*.json` (#2305 slice
// 1b — one self-contained, gist-distributable JSON file per kit). `react-ui` is the app's own shared-UI
// primitives, GENERATED from the introspection manifest (`reactUiKit.ts`, kept in sync by
// `reactUiKit.gen.test.ts`). The hand-authored `examples` demo kit was retired (#2506): react-ui's own
// pages tier (#2505) supersedes its page→primitive exemplar role, and the #2483 seed refresh deletes
// its pristine copies from existing stores on the next boot. This is what the library shows until the
// global `bsc ui` store lands (then `hydrateComponents` replaces it).
import type { ComponentRecord, Kit } from "./model";
import { makeBuiltinKits } from "./builtinKits";
import { reconcileSeed, type SeedReconcile } from "./seedRefresh";

const { kits, components } = makeBuiltinKits();

/** The packaged built-in kits (the generated react-ui kit), from `@data/components/*.json`. */
export const SEED_KITS: Kit[] = kits;

/** The packaged built-in components — the generated react-ui kit's records. */
export const SEED_COMPONENTS: ComponentRecord[] = components;

/** Reconcile the store's loaded components with the packaged built-ins (#2483, hash-based refresh —
 *  the full verdict table lives on {@link reconcileSeed}): a PRISTINE built-in copy (its content
 *  still hashes to its stamped `seedHash`; a legacy no-hash copy counts as pristine) tracks the
 *  seed — refreshed when the seed changed, deleted when the built-in left the seed. A USER-EDITED
 *  built-in is always kept (store wins), with a notice when the seed diverged. User-authored records
 *  are never touched; built-ins the store lacks are re-added. `hydrateComponents` applies the
 *  pushes/drops so the store converges. */
export function reconcileComponents(loaded: ComponentRecord[]): SeedReconcile<ComponentRecord> {
  return reconcileSeed(loaded, SEED_COMPONENTS, "component");
}

/** Reconcile loaded kits with the packaged built-in kits (see {@link reconcileComponents}). */
export function reconcileKits(loaded: Kit[]): SeedReconcile<Kit> {
  return reconcileSeed(loaded, SEED_KITS, "kit");
}
