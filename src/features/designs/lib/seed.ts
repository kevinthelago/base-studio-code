// The packaged Component Library (#2269), loaded from `src-tauri/data/components/*.json` (#2305 slice
// 1b — one self-contained, gist-distributable JSON file per kit). `react-ui` is the app's own shared-UI
// primitives, GENERATED from the introspection manifest (`reactUiKit.ts`, kept in sync by
// `reactUiKit.gen.test.ts`). The hand-authored `examples` demo kit was retired (#2506): react-ui's own
// pages tier (#2505) supersedes its page→primitive exemplar role, and the #2483 seed refresh deletes
// its pristine copies from existing stores on the next boot. This is what the library shows until the
// global `bsc ui` store lands (then `hydrateComponents` replaces it).
import type { ComponentRecord, Kit } from "./model";
import { makeBuiltinKits } from "./builtinKits";
import { makeBaseKit } from "./baseKit";
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

// The app's own BASE motion library as a recoverable builtin kit (#3451) — `lift`/`fade-in`/`pulse`,
// owned here instead of inside the react-ui demo kit. It MUST be always-on: react-ui's primitives now
// REFERENCE these by name, so gating it behind the react-ui flag would leave them unresolvable.
const { kits: baseKits, components: baseComponents } = makeBaseKit();

/** The always-on viz kits (#3194/#3242) — array + matrix + graph — seeded regardless of the react-ui flag. */
const vizKits: Kit[] = [...algoKits, ...matrixKits, ...graphKits];
const vizComponents: ComponentRecord[] = [...algoComponents, ...matrixComponents, ...graphComponents];

/** Every kit seeded regardless of the react-ui flag (#3451) — the shared `base` motion library plus the
 *  three viz kits. These are self-contained builtins, not the react-ui default #3029 disabled. */
const alwaysOnKits: Kit[] = [...baseKits, ...vizKits];
const alwaysOnComponents: ComponentRecord[] = [...baseComponents, ...vizComponents];

/** The packaged built-in kits — the generated react-ui kit (`@data/components/*.json`) + the shared
 *  `base` motion kit (#3451) + the three viz kits (algo-viz #3194, matrix-viz + graph-viz #3242).
 *  Enumerated by the stamping + round-trip drift guards. */
export const SEED_KITS: Kit[] = [...kits, ...alwaysOnKits];

/** The packaged built-in components — react-ui's records + the three viz-kit demo components (#3194/#3242).
 *  The `base` kit is motion-only and contributes none (react-ui's primitives demo its animations). */
export const SEED_COMPONENTS: ComponentRecord[] = [...components, ...alwaysOnComponents];

/** TEMPORARY (#3029) — the packaged default `react-ui` kit is being REDEFINED by hand via the designer
 *  session (the generated-from-manifest default was lacking). While that's in progress the reconcile
 *  seeds NOTHING: an existing store's pristine `react-ui` built-ins retire on the next boot (the #2483
 *  "seed removed a built-in → drop pristine copies" path), and a fresh install starts empty — so the
 *  Design Studio library is a blank slate for the new default. `SEED_KITS`/`SEED_COMPONENTS` above, the
 *  `react-ui.json` artifact, the `shared/ui` manifest, and the generator are all UNTOUCHED (still the test
 *  fixtures + the preview/doctor artifact). To restore: flip this back to `true` (or point the reconcile
 *  at the new packaged kit) — a one-line revert. */
export const DEFAULT_KIT_SEEDED = false;

/** The packaged kit id that {@link DEFAULT_KIT_SEEDED} gates — the ONE kit #3029 is redefining by hand.
 *  Every other `@data/components/*.json` kit is a new, self-contained builtin and must NOT inherit that
 *  gate: before #3462 the flag was applied to the whole glob, so any kit added alongside react-ui was
 *  silently inert (present in {@link SEED_COMPONENTS} and under test, but never reconciled into the
 *  store — records that exist on paper and nowhere in the library). */
export const DEFAULT_KIT_ID = "react-ui";

const defaultKits = kits.filter((k) => k.id === DEFAULT_KIT_ID);
const defaultComponents = components.filter((c) => c.kitId === DEFAULT_KIT_ID);

/** The packaged kits that are NOT the gated default (the `fleet` kit, #3462 — base-studio-code's own UI
 *  migrating into the components graph). Same standing as the always-on kits: self-contained builtins
 *  that seed regardless of the flag, so they're recoverable + shadow-proof. Note these come from the
 *  JSON glob, while `base`/viz are assembled in code — so the two sets never overlap. */
const packagedKits = kits.filter((k) => k.id !== DEFAULT_KIT_ID);
const packagedComponents = components.filter((c) => c.kitId !== DEFAULT_KIT_ID);

/** The seed the reconcile converges the store toward. The shared `base` motion kit (#3451), the three viz
 *  kits (algo-viz #3194, matrix-viz + graph-viz #3242) and every non-default packaged kit (#3462) seed
 *  UNCONDITIONALLY — they're self-contained builtins (not the react-ui default #3029 is redefining by
 *  hand), so they're recoverable + shadow-proof (re-added if the store lacks them) even while
 *  {@link DEFAULT_KIT_SEEDED} is off. `base` in particular MUST be unconditional: react-ui's primitives
 *  reference its animations by name, so a gated `base` would leave them unresolvable. react-ui ALONE
 *  stays gated on the flag: when it's off the reconcile retires react-ui's pristine copies (add nothing)
 *  and seeds the rest; when it's on, everything seeds. */
const seededKits = [...(DEFAULT_KIT_SEEDED ? defaultKits : []), ...packagedKits, ...alwaysOnKits];
const seededComponents = [
  ...(DEFAULT_KIT_SEEDED ? defaultComponents : []),
  ...packagedComponents,
  ...alwaysOnComponents,
];

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
