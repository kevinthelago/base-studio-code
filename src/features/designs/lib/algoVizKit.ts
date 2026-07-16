// The `algo-viz` builtin kit assembly (#3194, epic #3171/#2942) — registers the algorithm-visualization
// motion library (compare / swap / set / sorted) as a RECOVERABLE builtin kit in the Designs store, so
// the base animation set is VISIBLE + EDITABLE in the Design Studio (its AnimationsMenu) and self-heals
// if deleted.
//
// WHY A SEPARATE SEAM FROM `makeBuiltinKits`: the packaged kits (`react-ui.json`) are assembled from JSON
// files, which cannot reference a TS constant. This kit's motion IS a TS constant (`ALGO_VIZ_ANIMATIONS`,
// the SAME data the ArrayView renderer compiles — reused, never duplicated), so it's assembled in code
// here. `seed.ts` seeds it UNCONDITIONALLY — it is a new, self-contained builtin, NOT the react-ui
// default that #3029 temporarily disabled — so it's recoverable + shadow-proof (the #2483 reconcile
// re-adds it if the store lacks it) even while `DEFAULT_KIT_SEEDED` is off.
//
// HOW RECOVER/SHADOW-PROOF WORKS (free, via #2483): both the kit and its demo component are `builtin:
// true` + `seedHash`-stamped. `reconcileSeed` (seedRefresh.ts) appends+pushes any seed record the store
// LACKS (first run / re-added if the user deleted it) and refreshes a pristine-but-stale copy, while
// keeping a user EDIT (with a notice). No bespoke deletion guard — recovery IS the mechanism.
import { ALGO_VIZ_KIT_ID, ALGO_VIZ_ANIMATIONS } from "@/shared/ui/kit/algoVizAnimations";
import type { ComponentRecord, Kit } from "./model";
import { stampSeedHash } from "./seedRefresh";

/** The demo component's id — a self-contained cell-row that previews the base motions. */
export const ALGO_CELLS_ID = "algocells";

/**
 * A SELF-CONTAINED demo module (#3194) — the `srcText` the Design-Studio preview builds. No `@/` imports
 * (so `looksBuildableModule` accepts it and the sandboxed iframe builds cleanly) and JSX via the automatic
 * runtime (no React import needed). It renders a short row of cells, each carrying the data-state the
 * kit's animations key on (`data-op="compare|swap|set"` / `data-mark="sorted"`); the preview frame stamps
 * the `.algo-viz-anim-*` applying classes on `#root`, so on mount the cells visibly play compare / swap /
 * set / sorted. (ArrayView-as-a-real-component is a later step — this is the v1 shelf-surfacing demo.)
 */
const ALGO_CELLS_SRC = `// AlgoCells (#3194) — a self-contained demo of the algo-viz base motions. Each cell carries the
// data-state the kit's animations key on, so the Design-Studio preview plays compare / swap / set /
// sorted on mount. No imports: JSX uses the automatic runtime; the .algo-viz-anim-* applying classes
// are stamped on #root by the preview frame.
const CELLS = [
  { v: 5, op: "compare" },
  { v: 8, op: "swap" },
  { v: 2, op: "set" },
  { v: 1, mark: "sorted" },
  { v: 9 },
];

export function AlgoCells() {
  return (
    <div style={{ display: "flex", gap: 10, padding: 18, fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>
      {CELLS.map((c, i) => (
        <div
          key={i}
          data-op={c.op}
          data-mark={c.mark}
          style={{
            width: 44,
            height: 44,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 8,
            border: "1px solid var(--border, #333)",
            background: "var(--bg-elev, #1b1b1f)",
            color: "var(--fg, #e8e8ea)",
            fontSize: 16,
            fontWeight: 600,
          }}
        >
          {c.v}
        </div>
      ))}
    </div>
  );
}
`;

/**
 * Assemble the `algo-viz` builtin kit + its demo component, `builtin`- and `seedHash`-stamped exactly like
 * the packaged kits (`makeBuiltinKits`). The kit's `animations` is the SHARED {@link ALGO_VIZ_ANIMATIONS}
 * (one definition, reused by the ArrayView renderer too); the demo component binds all four by NAME so
 * they surface as its motion presets AND the kit's generic shelf in the AnimationsMenu.
 *
 * Every field that the componentBridge load projection DEFAULTS (`version`/`tags`/`variants`/`composes`/
 * `props`/`whenUse`/`whenNot`/`src`/`srcText`) is set explicitly at its default so the record survives the
 * push→store→load round-trip byte-for-byte (the #2514 contract, `seedRoundTrip.test.ts`) — an absent
 * optional (`wraps`/`rules`/`shapes`/`source`) stays absent.
 */
export function makeAlgoVizKit(): { kits: Kit[]; components: ComponentRecord[] } {
  // Typed consts (not inline literals) so `role`/etc. aren't widened, and so `kit.animations` stays the
  // SAME reference as ALGO_VIZ_ANIMATIONS through the shallow-spread stamp (one definition, no copy).
  const kit: Kit = {
    id: ALGO_VIZ_KIT_ID,
    name: "Algorithm Viz",
    // Rail hierarchy tech → style → kit: React components, in their own "data-viz" visual language.
    tech: "react",
    style: "data-viz",
    stack: "React · Data viz",
    dot: "var(--violet)",
    animations: ALGO_VIZ_ANIMATIONS,
    builtin: true,
  };

  const demo: ComponentRecord = {
    id: ALGO_CELLS_ID,
    name: "AlgoCells",
    kitId: ALGO_VIZ_KIT_ID,
    role: "primitive",
    group: "data-viz",
    version: "1.0.0",
    used: 0,
    tags: ["array", "motion", "sort"],
    variants: ["default"],
    composes: [],
    props: [],
    whenUse: ["Preview the algo-viz base motions (compare / swap / set / sorted) on a row of cells."],
    whenNot: ["Rendering a real algorithm trace — use ArrayView (a later step)."],
    src: "algo-viz/AlgoCells.tsx",
    srcText: ALGO_CELLS_SRC,
    // Bind the four kit animations by NAME — they resolve from the kit's `animations` library, surfacing
    // as this component's motion presets and marking the kit shelf rows referenced.
    animations: ALGO_VIZ_ANIMATIONS.map((a) => a.name),
    builtin: true,
  };

  return { kits: [stampSeedHash(kit)], components: [stampSeedHash(demo)] };
}
