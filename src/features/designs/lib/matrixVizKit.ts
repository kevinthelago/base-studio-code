// The `matrix-viz` builtin kit assembly (#3242, epic #3220/#2942) — registers the matrix-visualization
// motion library (read / write / region) as a RECOVERABLE builtin kit in the Designs store, so the set is
// VISIBLE + EDITABLE in the Design Studio's AnimationsMenu and self-heals if deleted. The 2-D twin of
// `algoVizKit` (#3194) — see that module for the full why (separate seam from `makeBuiltinKits`, and how
// recover/shadow-proof works via the #2483 reconcile).
import { MATRIX_VIZ_KIT_ID, MATRIX_VIZ_ANIMATIONS } from "@/shared/ui/kit/matrixVizAnimations";
import type { ComponentRecord, Kit } from "./model";
import { stampSeedHash } from "./seedRefresh";

/** The demo component's id — a self-contained grid that previews the matrix base motions. */
export const MATRIX_CELLS_ID = "matrixcells";

/**
 * A SELF-CONTAINED demo module (#3242) — the `srcText` the Design-Studio preview builds. No `@/` imports
 * and JSX via the automatic runtime. It renders a small grid of cells, each carrying the data-state the
 * kit's animations key on (`data-op="read|write|region"`); the preview frame stamps the
 * `.matrix-viz-anim-*` applying classes on `#root`, so on mount the cells visibly play read / write / region.
 */
const MATRIX_CELLS_SRC = `// MatrixCells (#3242) — a self-contained demo of the matrix-viz base motions. Each cell carries the
// data-state the kit's animations key on, so the Design-Studio preview plays read / write / region on
// mount. No imports: JSX uses the automatic runtime; the .matrix-viz-anim-* applying classes are stamped
// on #root by the preview frame.
const CELLS = [
  { v: 1, op: "read" }, { v: 2, op: "write" }, { v: 3 },
  { v: 4 }, { v: 5, op: "region" }, { v: 6, op: "region" },
  { v: 7, op: "write" }, { v: 8 }, { v: 9, op: "read" },
];

export function MatrixCells() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 40px)", gap: 6, padding: 18, fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>
      {CELLS.map((c, i) => (
        <div
          key={i}
          data-op={c.op}
          style={{
            width: 40,
            height: 40,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 6,
            border: "1px solid var(--border, #333)",
            background: "var(--bg-elev, #1b1b1f)",
            color: "var(--fg, #e8e8ea)",
            fontSize: 15,
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
 * Assemble the `matrix-viz` builtin kit + its demo component, `builtin`- and `seedHash`-stamped exactly
 * like the packaged kits. The kit's `animations` is the SHARED {@link MATRIX_VIZ_ANIMATIONS} (one
 * definition, reused by the MatrixView renderer too — a copy would silently drift); the demo binds all
 * three by NAME so they surface as its motion presets AND the kit's shelf in the AnimationsMenu. Every
 * projection-defaulted field is set explicitly at its default so the record survives the push→store→load
 * round-trip byte-for-byte (the #2514 contract).
 */
export function makeMatrixVizKit(): { kits: Kit[]; components: ComponentRecord[] } {
  const kit: Kit = {
    id: MATRIX_VIZ_KIT_ID,
    name: "Matrix Viz",
    tech: "react",
    style: "data-viz",
    stack: "React · Data viz",
    dot: "var(--violet)",
    animations: MATRIX_VIZ_ANIMATIONS,
    builtin: true,
  };

  const demo: ComponentRecord = {
    id: MATRIX_CELLS_ID,
    name: "MatrixCells",
    kitId: MATRIX_VIZ_KIT_ID,
    role: "primitive",
    group: "data-viz",
    version: "1.0.0",
    used: 0,
    tags: ["matrix", "motion", "transform"],
    variants: ["default"],
    composes: [],
    props: [],
    whenUse: ["Preview the matrix-viz base motions (read / write / region) on a grid of cells."],
    whenNot: ["Rendering a real matrix trace — use MatrixView (a later step)."],
    src: "matrix-viz/MatrixCells.tsx",
    srcText: MATRIX_CELLS_SRC,
    animations: MATRIX_VIZ_ANIMATIONS.map((a) => a.name),
    builtin: true,
  };

  return { kits: [stampSeedHash(kit)], components: [stampSeedHash(demo)] };
}
