// The `stack` viz kit's MOTION wiring (#3266, epic #3220/#2942) — injects the compiled motion CSS
// (push / pop / peek) into the live StackView. The animation DATA lives in a SHARED, feature-agnostic home
// (`@/shared/ui/kit/stackVizAnimations`) so BOTH consumers read ONE definition: this renderer AND a
// (later) `stack-viz` Designs builtin kit. `StackView`'s root carries the applying classes ({@link
// STACK_VIZ_ANIM_CLASSES}); its cells only stamp `data-op`. Mirrors matrixViewMotion / arrayViewMotion.
import { animClassName, compileAnimationsCss, kitAnimations } from "@/shared/ui/kit";
import { STACK_VIZ_KIT_ID, STACK_VIZ_ANIMATIONS } from "@/shared/ui/kit/stackVizAnimations";

// Re-export the shared data so this renderer's public surface (and the algorithms barrel) is unchanged.
export { STACK_VIZ_KIT_ID, STACK_VIZ_ANIMATIONS };

/** The applying classes the renderer's root carries so the state-scoped rules match its cells. */
export const STACK_VIZ_ANIM_CLASSES: string = STACK_VIZ_ANIMATIONS.map((a) =>
  animClassName({ kit: STACK_VIZ_KIT_ID, name: a.name }),
).join(" ");

/** The compiled motion CSS — produced ONCE from {@link STACK_VIZ_ANIMATIONS}. Pure. */
export const STACK_VIZ_MOTION_CSS: string = compileAnimationsCss(
  kitAnimations([{ id: STACK_VIZ_KIT_ID, animations: STACK_VIZ_ANIMATIONS }]),
);

const STYLE_ID = "bsc-stack-viz-animations";

/** Inject the compiled stack motion CSS into a dedicated managed `<style>` (idempotent). `doc` param'd for
 *  tests. Mirrors `ensureArrayViewMotion` on its own style id. */
export function ensureStackViewMotion(doc: Document = document): void {
  if (!STACK_VIZ_MOTION_CSS) return;
  let el = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = doc.createElement("style");
    el.id = STYLE_ID;
    doc.head.appendChild(el);
  }
  if (el.textContent !== STACK_VIZ_MOTION_CSS) el.textContent = STACK_VIZ_MOTION_CSS;
}
