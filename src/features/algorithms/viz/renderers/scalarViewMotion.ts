// The `scalar` viz kit's MOTION wiring (#3268, epic #3220/#2942) — injects the compiled motion CSS
// (set / add / compare) into the live ScalarView. The animation DATA lives in a SHARED, feature-agnostic
// home (`@/shared/ui/kit/scalarVizAnimations`) so BOTH consumers read ONE definition: this renderer AND a
// (later) `scalar-viz` Designs builtin kit. `ScalarView`'s root carries the applying classes ({@link
// SCALAR_VIZ_ANIM_CLASSES}); its chips only stamp `data-op`. Mirrors stackViewMotion / arrayViewMotion.
import { animClassName, compileAnimationsCss, kitAnimations } from "@/shared/ui/kit";
import { SCALAR_VIZ_KIT_ID, SCALAR_VIZ_ANIMATIONS } from "@/shared/ui/kit/scalarVizAnimations";

// Re-export the shared data so this renderer's public surface (and the algorithms barrel) is unchanged.
export { SCALAR_VIZ_KIT_ID, SCALAR_VIZ_ANIMATIONS };

/** The applying classes the renderer's root carries so the state-scoped rules match its chips. */
export const SCALAR_VIZ_ANIM_CLASSES: string = SCALAR_VIZ_ANIMATIONS.map((a) =>
  animClassName({ kit: SCALAR_VIZ_KIT_ID, name: a.name }),
).join(" ");

/** The compiled motion CSS — produced ONCE from {@link SCALAR_VIZ_ANIMATIONS}. Pure. */
export const SCALAR_VIZ_MOTION_CSS: string = compileAnimationsCss(
  kitAnimations([{ id: SCALAR_VIZ_KIT_ID, animations: SCALAR_VIZ_ANIMATIONS }]),
);

const STYLE_ID = "bsc-scalar-viz-animations";

/** Inject the compiled scalar motion CSS into a dedicated managed `<style>` (idempotent). `doc` param'd for
 *  tests. Mirrors `ensureStackViewMotion` on its own style id. */
export function ensureScalarViewMotion(doc: Document = document): void {
  if (!SCALAR_VIZ_MOTION_CSS) return;
  let el = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = doc.createElement("style");
    el.id = STYLE_ID;
    doc.head.appendChild(el);
  }
  if (el.textContent !== SCALAR_VIZ_MOTION_CSS) el.textContent = SCALAR_VIZ_MOTION_CSS;
}
