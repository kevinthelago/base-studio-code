// The `array` viz kit's MOTION wiring (#3178, epic #3171/#2942) — injects the compiled motion CSS
// (compare / swap / set / sorted) into the live ArrayView. The animation DATA itself now lives in a
// SHARED, feature-agnostic home (`@/shared/ui/kit/algoVizAnimations`) so BOTH consumers read ONE
// definition: this renderer AND the Designs `algo-viz` builtin kit (#3194) — see that module's doc for
// the why and the state-trigger seam. `ArrayView`'s root carries the applying classes
// ({@link ALGO_VIZ_ANIM_CLASSES}); its cells only stamp `data-op` / `data-mark`. Change an animation's
// data in the shared module → every array visualization AND the Design-Studio kit shelf update, no
// renderer change.
//
// The #3194 kit registration (RESIDUAL, now DONE): the Designs seed registers `ALGO_VIZ_ANIMATIONS` as a
// recoverable builtin kit so `AnimationsMenu` lists + edits them; this renderer keeps its own dedicated
// managed `<style>` (below) so the two paths never clobber each other.

import { animClassName, compileAnimationsCss, kitAnimations } from "@/shared/ui/kit";
import { ALGO_VIZ_KIT_ID, ALGO_VIZ_ANIMATIONS } from "@/shared/ui/kit/algoVizAnimations";

// Re-export the shared data so this renderer's public surface (and the algorithms barrel) is unchanged.
export { ALGO_VIZ_KIT_ID, ALGO_VIZ_ANIMATIONS };

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
