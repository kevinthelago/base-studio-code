// The `array` viz kit's MOTION library (#3178, epic #3171/#2942) — the compare / swap / set / sorted
// animations authored as KitAnimation DATA and compiled by the kit-motion engine (`compileAnimationsCss`),
// NOT as hand-written CSS `@keyframes`. This is the epic's core vision: motion is data, so it's editable
// in the Designer's Animations menu instead of baked into a renderer's stylesheet.
//
// THE STATE-TRIGGER SEAM (#3058) — how "verb → data-state → animation" is expressed in the current
// engine: there is no `trigger: "state"`; a state trigger is a KitAnimation whose `selector` IS the
// data-state (`[data-op="swap"]`). The engine compiles it to a rule
//
//     .algo-viz-anim-swap [data-op="swap"] { animation: bsc-algo-viz-swap …; }
//
// which plays whenever a DESCENDANT of the applying-class root matches that state — i.e. exactly when
// `ArrayView` stamps `data-op="swap"` on a cell (see lib/binding.ts). `ArrayView`'s root carries the
// applying classes ({@link ALGO_VIZ_ANIM_CLASSES}); its cells still ONLY stamp `data-op` / `data-mark`.
// Change an animation's data here → every array visualization updates, no renderer change.
//
// RESIDUAL (noted, not built here): these live as an in-code KitAnimation[] rather than a registered
// `algo-viz` kit in the component-kit store, so they compile + play but are not yet LISTED/EDITED in the
// AnimationsMenu. Registering this kit into the Designs kit store (so `AnimationsMenu` renders + persists
// edits, and `applyAnimationsToRoot(kitAnimations(kits))` compiles it globally) is the follow-up — it
// consumes this exact data (`ALGO_VIZ_ANIMATIONS`) unchanged.

import { animClassName, compileAnimationsCss, kitAnimations, type KitAnimation } from "@/shared/ui/kit";

/** The array-visualization motion kit id — `.algo-viz-anim-<name>` + `@keyframes bsc-algo-viz-<name>`. */
export const ALGO_VIZ_KIT_ID = "algo-viz";

/**
 * The array viz kit's animations as DATA (#2942), each a STATE trigger keyed on the data-state selector
 * `ArrayView` stamps — so the compiled rule fires on exactly `[data-op="compare"]` / `[data-op="swap"]`
 * / `[data-op="set"]` / `[data-mark="sorted"]`. Token-based colors + durations; the engine wraps every
 * applying rule in `@media (prefers-reduced-motion: no-preference)`, so reduced-motion is handled for
 * free. Editable data — this is what a Designer Animations-menu integration would surface (see RESIDUAL).
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

/** The applying classes the renderer's root must carry so the state-scoped rules match its cells —
 *  the kit-binding convention (`the renderer puts .<kit>-anim-<name> on the element`). Derived from the
 *  animation data so it never drifts. */
export const ALGO_VIZ_ANIM_CLASSES: string = ALGO_VIZ_ANIMATIONS.map((a) =>
  animClassName({ kit: ALGO_VIZ_KIT_ID, name: a.name }),
).join(" ");

/** The compiled motion CSS for the kit — produced ONCE by the engine (`compileAnimationsCss`) from the
 *  {@link ALGO_VIZ_ANIMATIONS} data. Pure (no DOM); injected by {@link ensureArrayViewMotion}. */
export const ALGO_VIZ_MOTION_CSS: string = compileAnimationsCss(
  kitAnimations([{ id: ALGO_VIZ_KIT_ID, animations: ALGO_VIZ_ANIMATIONS }]),
);

/** The dedicated managed `<style>` id — SEPARATE from the global `bsc-ui-animations` sheet so wiring the
 *  viz kit in never clobbers the Designs feature's kit animations. */
const STYLE_ID = "bsc-algo-viz-animations";

/**
 * Inject the compiled viz-kit motion CSS into a dedicated managed `<style id="bsc-algo-viz-animations">`
 * (idempotent — one element, updated in place). Mirrors `applyAnimationsToRoot` but on its OWN style id,
 * so it coexists with the global animation sheet. `doc` is param'd for tests. No-op if nothing compiled.
 */
export function ensureArrayViewMotion(doc: Document = document): void {
  if (!ALGO_VIZ_MOTION_CSS) return;
  let el = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = doc.createElement("style");
    el.id = STYLE_ID;
    doc.head.appendChild(el);
  }
  if (el.textContent !== ALGO_VIZ_MOTION_CSS) el.textContent = ALGO_VIZ_MOTION_CSS;
}
