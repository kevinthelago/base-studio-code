// The `scalar-viz` kit's MOTION library as DATA (#3268, epic #3171/#2942) — the set / add / compare
// animations for the scalar-state renderer (counters, accumulators, the current pointer), authored as
// {@link KitAnimation} data and compiled by the kit-motion engine. The scalar twin of the
// array/matrix/graph/stack motion sets.
//
// ── WHY THIS LIVES IN shared/ui/kit ──────────────────────────────────────────────────────────────────
// Like the array (#3194) + matrix/graph (#3242) + stack (#3266) sets: two consumers in two features, one
// definition — the Algorithms ScalarView renderer (`features/algorithms/.../scalarViewMotion.ts`) injects
// the compiled CSS, and the Designs seed can register `scalar-viz` as a recoverable builtin kit (a later
// slice). Feature-agnostic viz-motion, so it lives HERE to avoid a designs↔algorithms cycle.
//
// STATE-TRIGGER SEAM (#3058): each selector IS the data-state ScalarView stamps on the touched variable's
// chip (`[data-op="set"]`, …) — so a rule fires exactly when a variable changes.

import type { KitAnimation } from "./animations";

/** The scalar-visualization motion kit id — `.scalar-viz-anim-<name>` + `@keyframes bsc-scalar-viz-<name>`. */
export const SCALAR_VIZ_KIT_ID = "scalar-viz";

/** The scalar kit's animations as DATA — set (the value is replaced — a quick highlight flip), add (the
 *  accumulator ticks up — a subtle bump + accent flash), compare (a brief ring on a read that doesn't
 *  change the value). Token-based; the engine wraps each in `prefers-reduced-motion: no-preference`. The
 *  single source the ScalarView renderer + the (later) `scalar-viz` Designs kit both consume. */
export const SCALAR_VIZ_ANIMATIONS: KitAnimation[] = [
  // set — the variable takes a new value: a quick accent highlight as the readout flips.
  {
    name: "set",
    selector: '[data-op="set"]',
    duration: "380ms",
    easing: "var(--ease-standard)",
    keyframes: {
      "0%": { "border-color": "var(--accent)", background: "color-mix(in oklch, var(--accent), var(--bg-elev) 55%)" },
      "100%": { background: "var(--bg-elev)" },
    },
  },
  // add — the accumulator increments: a small upward bump + accent flash (a counter ticking).
  {
    name: "add",
    selector: '[data-op="add"]',
    duration: "420ms",
    easing: "cubic-bezier(0.34, 1.4, 0.5, 1)",
    keyframes: {
      "0%": { transform: "translateY(3px) scale(0.94)", "border-color": "var(--success)" },
      "55%": { transform: "translateY(-2px) scale(1.04)" },
      "100%": { transform: "translateY(0) scale(1)" },
    },
  },
  // compare — a brief ring on a read (a threshold check that leaves the value unchanged).
  {
    name: "compare",
    selector: '[data-op="compare"]',
    duration: "450ms",
    easing: "var(--ease-standard)",
    keyframes: {
      "0%": { "box-shadow": "0 0 0 0 transparent" },
      "45%": { "box-shadow": "0 0 0 2px color-mix(in oklch, var(--state-wait), transparent 45%)" },
      "100%": { "box-shadow": "0 0 0 0 transparent" },
    },
  },
];
