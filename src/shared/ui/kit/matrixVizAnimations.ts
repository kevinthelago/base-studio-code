// The `matrix-viz` kit's MOTION library as DATA (#3221/#3242, epic #3220/#2942) — the read / write /
// region animations authored as {@link KitAnimation} data, compiled by the kit-motion engine
// (`compileAnimationsCss`). The 2-D twin of `algoVizAnimations`.
//
// ── WHY THIS LIVES IN shared/ui/kit (not in the algorithms feature) ───────────────────────────────────
// Like the array set (#3194), it has EXACTLY TWO consumers in two features and must be ONE definition:
//   1. the Algorithms MatrixView renderer (`features/algorithms/.../matrixViewMotion.ts`) — injects the
//      compiled CSS into the live visualization; and
//   2. the Designs seed (`features/designs/lib/matrixVizKit.ts` → `seed.ts`) — registers `matrix-viz` as
//      a recoverable builtin kit so the set is visible + editable in the Design Studio's AnimationsMenu.
// Importing the Algorithms barrel from the Designs seed would eagerly pull the whole algorithms feature
// into the store-boot module graph and risk a designs↔algorithms seed cycle — so the feature-agnostic
// viz-motion data lives HERE, a leaf both features import cheaply (#3242).
//
// STATE-TRIGGER SEAM (#3058): each animation's `selector` IS the data-state MatrixView stamps
// (`[data-op="write"]`, …), so the compiled rule fires when a cell reaches that state. The renderer's root
// carries the applying classes; cells only stamp `data-op` / `data-mark`.

import type { KitAnimation } from "./animations";

/** The matrix-visualization motion kit id — `.matrix-viz-anim-<name>` + `@keyframes bsc-matrix-viz-<name>`. */
export const MATRIX_VIZ_KIT_ID = "matrix-viz";

/** The matrix kit's animations as DATA — read (a highlight pulse on an examined cell), write (a pop as a
 *  value lands — the workhorse of transpose/rotate/reflect), region (a block tint fading out). Token-based
 *  colours; the engine wraps each in `prefers-reduced-motion: no-preference`. The single source of truth
 *  the MatrixView renderer AND the Designs `matrix-viz` builtin kit both consume. */
export const MATRIX_VIZ_ANIMATIONS: KitAnimation[] = [
  // read — a quick ring on the cell being examined.
  {
    name: "read",
    selector: '[data-op="read"]',
    duration: "450ms",
    easing: "var(--ease-standard)",
    set: { "z-index": "1" },
    keyframes: {
      "0%": { "box-shadow": "0 0 0 0 transparent", "border-color": "var(--border)" },
      "45%": {
        "box-shadow": "0 0 0 2px color-mix(in oklch, var(--state-wait), transparent 45%)",
        "border-color": "var(--state-wait)",
      },
      "100%": { "box-shadow": "0 0 0 0 transparent", "border-color": "var(--border)" },
    },
  },
  // write — a cell pops + tints to the accent as its new value lands (a swapped / rotated cell).
  {
    name: "write",
    selector: '[data-op="write"]',
    duration: "440ms",
    easing: "cubic-bezier(0.34, 1.4, 0.5, 1)",
    set: { "z-index": "2" },
    keyframes: {
      "0%": {
        transform: "scale(1.16)",
        background: "color-mix(in oklch, var(--accent), var(--bg-elev) 45%)",
        "border-color": "var(--accent)",
      },
      "100%": { transform: "scale(1)" },
    },
  },
  // region — a rectangular block tints and fades (a submatrix / layer highlight).
  {
    name: "region",
    selector: '[data-op="region"]',
    duration: "600ms",
    easing: "var(--ease-standard)",
    keyframes: {
      "0%": { background: "color-mix(in oklch, var(--info), transparent 78%)" },
      "100%": { background: "var(--bg-elev)" },
    },
  },
];
