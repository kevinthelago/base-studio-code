// The `matrix` viz kit's MOTION wiring (#3221, epic #3220/#2942) — injects the compiled motion CSS
// (read / write / region) into the live MatrixView. The animation DATA itself now lives in a SHARED,
// feature-agnostic home (`@/shared/ui/kit/matrixVizAnimations`, #3242) so BOTH consumers read ONE
// definition: this renderer AND the Designs `matrix-viz` builtin kit — see that module's doc for the why
// and the state-trigger seam. `MatrixView`'s root carries the applying classes ({@link
// MATRIX_VIZ_ANIM_CLASSES}); its cells only stamp `data-op`/`data-mark`.
import { animClassName, compileAnimationsCss, kitAnimations } from "@/shared/ui/kit";
import { MATRIX_VIZ_KIT_ID, MATRIX_VIZ_ANIMATIONS } from "@/shared/ui/kit/matrixVizAnimations";

// Re-export the shared data so this renderer's public surface (and the algorithms barrel) is unchanged.
export { MATRIX_VIZ_KIT_ID, MATRIX_VIZ_ANIMATIONS };

/** The applying classes the renderer's root carries so the state-scoped rules match its cells. */
export const MATRIX_VIZ_ANIM_CLASSES: string = MATRIX_VIZ_ANIMATIONS.map((a) =>
  animClassName({ kit: MATRIX_VIZ_KIT_ID, name: a.name }),
).join(" ");

/** The compiled motion CSS — produced ONCE by the engine from {@link MATRIX_VIZ_ANIMATIONS}. Pure. */
export const MATRIX_VIZ_MOTION_CSS: string = compileAnimationsCss(
  kitAnimations([{ id: MATRIX_VIZ_KIT_ID, animations: MATRIX_VIZ_ANIMATIONS }]),
);

const STYLE_ID = "bsc-matrix-viz-animations";

/** Inject the compiled matrix motion CSS into a dedicated managed `<style>` (idempotent). `doc` is param'd
 *  for tests. Mirrors `ensureArrayViewMotion` on its own style id. */
export function ensureMatrixViewMotion(doc: Document = document): void {
  if (!MATRIX_VIZ_MOTION_CSS) return;
  let el = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = doc.createElement("style");
    el.id = STYLE_ID;
    doc.head.appendChild(el);
  }
  if (el.textContent !== MATRIX_VIZ_MOTION_CSS) el.textContent = MATRIX_VIZ_MOTION_CSS;
}
