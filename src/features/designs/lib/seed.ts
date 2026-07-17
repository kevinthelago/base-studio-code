// The packaged Component Library (#2269), loaded from `src-tauri/data/components/*.json` (#2305 slice
// 1b — one self-contained, gist-distributable JSON file per kit). `react-ui` is the app's own shared-UI
// primitives, GENERATED from the introspection manifest (`reactUiKit.ts`, kept in sync by
// `reactUiKit.gen.test.ts`). The hand-authored `examples` demo kit was retired (#2506): react-ui's own
// pages tier (#2505) supersedes its page→primitive exemplar role, and the #2483 seed refresh deletes
// its pristine copies from existing stores on the next boot. This is what the library shows until the
// global `bsc ui` store lands (then `hydrateComponents` replaces it).
import type { ComponentRecord, Kit } from "./model";
import { makeBuiltinKits } from "./builtinKits";
import { makeAlgoVizKit } from "./algoVizKit";
import { makeMatrixVizKit } from "./matrixVizKit";
import { makeGraphVizKit } from "./graphVizKit";
import { reconcileSeed, type SeedReconcile } from "./seedRefresh";

const { kits, components } = makeBuiltinKits();
// The algorithm-visualization motion libraries as recoverable builtin kits (#3194 array, #3242 matrix +
// graph). Assembled in code (their motion is a TS constant, not JSON) and seeded UNCONDITIONALLY below —
// they're new, self-contained builtins, not the react-ui default #3029 disabled.
const { kits: algoKits, components: algoComponents } = makeAlgoVizKit();
const { kits: matrixKits, components: matrixComponents } = makeMatrixVizKit();
const { kits: graphKits, components: graphComponents } = makeGraphVizKit();

/** The always-on viz kits (#3194/#3242) — array + matrix + graph — seeded regardless of the react-ui flag. */
const vizKits: Kit[] = [...algoKits, ...matrixKits, ...graphKits];
const vizComponents: ComponentRecord[] = [...algoComponents, ...matrixComponents, ...graphComponents];

/** The packaged built-in kits — the generated react-ui kit (`@data/components/*.json`) + the three viz
 *  kits (algo-viz #3194, matrix-viz + graph-viz #3242). Enumerated by the stamping + round-trip drift guards. */
export const SEED_KITS: Kit[] = [...kits, ...vizKits];

/** The packaged built-in components — react-ui's records + the three viz-kit demo components (#3194/#3242). */
export const SEED_COMPONENTS: ComponentRecord[] = [...components, ...vizComponents];

/** TEMPORARY (#3029) — the packaged default `react-ui` kit is being REDEFINED by hand via the designer
 *  session (the generated-from-manifest default was lacking). While that's in progress the reconcile
 *  seeds NOTHING: an existing store's pristine `react-ui` built-ins retire on the next boot (the #2483
 *  "seed removed a built-in → drop pristine copies" path), and a fresh install starts empty — so the
 *  Design Studio library is a blank slate for the new default. `SEED_KITS`/`SEED_COMPONENTS` above, the
 *  `react-ui.json` artifact, the `shared/ui` manifest, and the generator are all UNTOUCHED (still the test
 *  fixtures + the preview/doctor artifact). To restore: flip this back to `true` (or point the reconcile
 *  at the new packaged kit) — a one-line revert. */
export const DEFAULT_KIT_SEEDED = false;

/** The seed the reconcile converges the store toward. The three viz kits (algo-viz #3194, matrix-viz +
 *  graph-viz #3242) seed UNCONDITIONALLY — they're new, self-contained builtins (not the react-ui default
 *  #3029 is redefining by hand), so they're recoverable + shadow-proof (re-added if the store lacks them)
 *  even while {@link DEFAULT_KIT_SEEDED} is off. react-ui stays gated on the flag: when it's off the
 *  reconcile retires react-ui's pristine copies (add nothing) and seeds only the viz kits; when it's on both seed. */
const seededKits = DEFAULT_KIT_SEEDED ? SEED_KITS : vizKits;
const seededComponents = DEFAULT_KIT_SEEDED ? SEED_COMPONENTS : vizComponents;

/** Reconcile the store's loaded components with the packaged built-ins (#2483, hash-based refresh —
 *  the full verdict table lives on {@link reconcileSeed}): a PRISTINE built-in copy (its content
 *  still hashes to its stamped `seedHash`; a legacy no-hash copy counts as pristine) tracks the
 *  seed — refreshed when the seed changed, deleted when the built-in left the seed. A USER-EDITED
 *  built-in is always kept (store wins), with a notice when the seed diverged. User-authored records
 *  are never touched; built-ins the store lacks are re-added. `hydrateComponents` applies the
 *  pushes/drops so the store converges. */
export function reconcileComponents(loaded: ComponentRecord[]): SeedReconcile<ComponentRecord> {
  return reconcileSeed(loaded, seededComponents, "component");
}

/** Reconcile loaded kits with the packaged built-in kits (see {@link reconcileComponents}). */
export function reconcileKits(loaded: Kit[]): SeedReconcile<Kit> {
  return reconcileSeed(loaded, seededKits, "kit");
}
