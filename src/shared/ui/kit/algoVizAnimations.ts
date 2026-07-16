// The `algo-viz` kit's MOTION library as DATA (#2942/#3194, epic #3171) — the compare / swap / set /
// sorted animations authored as {@link KitAnimation} data, compiled by the kit-motion engine
// (`compileAnimationsCss`), NOT as hand-written CSS `@keyframes`. This is the epic's core vision: motion
// is data, so it's editable in the Designer's Animations menu instead of baked into a renderer's
// stylesheet.
//
// ── WHY THIS LIVES IN shared/ui/kit (not in either feature) ──────────────────────────────────────────
// It has EXACTLY TWO consumers, in two different features, and must be ONE definition (change `swap` once
// → every array visualization AND the Design-Studio kit shelf update in lockstep):
//   1. the Algorithms ArrayView renderer (`features/algorithms/.../arrayViewMotion.ts`,
//      `ensureArrayViewMotion`) — injects the compiled CSS into the live visualization; and
//   2. the Designs seed (`features/designs/lib/algoVizKit.ts` → `seed.ts`) — registers `algo-viz` as a
//      recoverable builtin kit so the set is visible + editable in the Design Studio's AnimationsMenu.
// Importing the Algorithms barrel from the Designs seed would eagerly pull the whole algorithms feature
// (its Workspace + graph) into the store-boot module graph and risks a designs↔algorithms seed cycle. The
// data is genuinely feature-agnostic viz-motion, so it lives HERE — a leaf both features import cheaply.
//
// ── THE STATE-TRIGGER SEAM (#3058) — "verb → data-state → animation" ─────────────────────────────────
// The current engine has no `trigger: "state"`; a state trigger is a KitAnimation whose `selector` IS the
// data-state (`[data-op="swap"]`). The engine compiles it to a rule
//
//     .algo-viz-anim-swap [data-op="swap"] { animation: bsc-algo-viz-swap …; }
//
// which plays whenever a DESCENDANT of the applying-class root matches that state — i.e. exactly when
// `ArrayView` stamps `data-op="swap"` on a cell. The renderer's root carries the applying classes; its
// cells only stamp `data-op` / `data-mark`. Change an animation's data here → every array visualization
// (and the kit's Design-Studio preview) updates, no renderer change.

import type { KitAnimation } from "./animations";

/** The array-visualization motion kit id — `.algo-viz-anim-<name>` + `@keyframes bsc-algo-viz-<name>`. */
export const ALGO_VIZ_KIT_ID = "algo-viz";

/**
 * The `algo-viz` kit's animations as DATA (#2942), each a STATE trigger keyed on the data-state selector
 * `ArrayView` stamps — so the compiled rule fires on exactly `[data-op="compare"]` / `[data-op="swap"]`
 * / `[data-op="set"]` / `[data-mark="sorted"]`. Token-based colors + durations; the engine wraps every
 * applying rule in `@media (prefers-reduced-motion: no-preference)`, so reduced-motion is handled for
 * free. This is the single source of truth the ArrayView renderer AND the Designs `algo-viz` builtin kit
 * both consume — one definition, two consumers.
 */
export const ALGO_VIZ_ANIMATIONS: KitAnimation[] = [
  // compare — a highlight pulse on the two compared cells.
  {
    name: "compare",
    selector: '[data-op="compare"]',
    duration: "500ms",
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
  // swap — the two cells lift, tint to the accent, and settle back as they exchange.
  {
    name: "swap",
    selector: '[data-op="swap"]',
    duration: "420ms",
    easing: "cubic-bezier(0.34, 1.4, 0.5, 1)",
    set: { "z-index": "2" },
    keyframes: {
      "0%": {
        transform: "translateY(0)",
        "border-color": "var(--accent)",
        background: "color-mix(in oklch, var(--accent), var(--bg-elev) 62%)",
      },
      "40%": { transform: "translateY(-12px) scale(1.05)" },
      "100%": { transform: "translateY(0)" },
    },
  },
  // set — a value flash (a fresh write into the cell).
  {
    name: "set",
    selector: '[data-op="set"]',
    duration: "500ms",
    easing: "var(--ease-standard)",
    keyframes: {
      "0%": { background: "color-mix(in oklch, var(--accent), transparent 20%)" },
      "100%": { background: "var(--bg-elev)" },
    },
  },
  // sorted — a one-shot settle as a cell reaches its final place (its DURABLE green resting look is a
  // static element style in arrayView.css, since a mark persists across frames — this is only the motion).
  {
    name: "sorted",
    selector: '[data-mark="sorted"]',
    duration: "300ms",
    easing: "var(--ease-standard)",
    keyframes: {
      "0%": { transform: "translateY(-3px)" },
      "100%": { transform: "translateY(0)" },
    },
  },
];
