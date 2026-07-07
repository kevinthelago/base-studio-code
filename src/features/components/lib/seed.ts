// The packaged Component Library (#2269), loaded from `src-tauri/data/components/*.json` (#2305 slice
// 1b — one self-contained, gist-distributable JSON file per kit). `react-ui` is the app's own shared-UI
// primitives, GENERATED from the introspection manifest (`reactUiKit.ts`, kept in sync by
// `reactUiKit.gen.test.ts`); `examples` is hand-authored demo data. This is what the library shows
// until the global `bsc ui` store lands (then `hydrateComponents` replaces it).
import type { ComponentRecord, Kit } from "./model";
import { makeBuiltinKits } from "./builtinKits";

const { kits, components } = makeBuiltinKits();

/** The packaged built-in kits (react-ui + the examples demo kit), from `@data/components/*.json`. */
export const SEED_KITS: Kit[] = kits;

/** The packaged built-in components — the generated react-ui kit + the examples demo kit. */
export const SEED_COMPONENTS: ComponentRecord[] = components;

/** Reconcile the store's loaded components with the packaged built-ins: the store wins for records it
 *  has (so a user edit to a built-in is preserved), and any built-in the store LACKS is re-added — the
 *  same seed-and-keep pattern as personas/orgs. `hydrateComponents` re-pushes the re-added built-ins so
 *  the store converges. */
export function reconcileComponents(loaded: ComponentRecord[]): ComponentRecord[] {
  const have = new Set(loaded.map((c) => c.id));
  return [...loaded, ...SEED_COMPONENTS.filter((b) => !have.has(b.id))];
}

/** Reconcile loaded kits with the packaged built-in kits (see {@link reconcileComponents}). */
export function reconcileKits(loaded: Kit[]): Kit[] {
  const have = new Set(loaded.map((k) => k.id));
  return [...loaded, ...SEED_KITS.filter((b) => !have.has(b.id))];
}
