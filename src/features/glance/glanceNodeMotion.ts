// The `glance-node` kit's MOTION wiring (#4032, epic #2942) — compiles the authored animation DATA
// into CSS once and injects it into a managed <style>. Mirrors `ensureGraphViewMotion` on its own
// style id; the animation data itself lives in `@/shared/ui/kit/glanceNodeAnimations` so the designer
// and this renderer read ONE definition.
import { animClassName, compileAnimationsCss, kitAnimations } from "@/shared/ui/kit";
import { GLANCE_NODE_KIT_ID, GLANCE_NODE_ANIMATIONS } from "@/shared/ui/kit/glanceNodeAnimations";

export { GLANCE_NODE_KIT_ID, GLANCE_NODE_ANIMATIONS };

/** The applying classes the node carries so the state-scoped rules match it. */
export const GLANCE_NODE_ANIM_CLASSES: string = GLANCE_NODE_ANIMATIONS.map((a) =>
  animClassName({ kit: GLANCE_NODE_KIT_ID, name: a.name }),
).join(" ");

/** The compiled motion CSS — produced ONCE from the authored data. Pure. */
export const GLANCE_NODE_MOTION_CSS: string = compileAnimationsCss(
  kitAnimations([{ id: GLANCE_NODE_KIT_ID, animations: GLANCE_NODE_ANIMATIONS }]),
);

const STYLE_ID = "bsc-glance-node-animations";

/** Inject the compiled node motion CSS into a dedicated managed `<style>` (idempotent). `doc` param'd
 *  for tests. */
export function ensureGlanceNodeMotion(doc: Document = document): void {
  if (!GLANCE_NODE_MOTION_CSS) return;
  let el = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = doc.createElement("style");
    el.id = STYLE_ID;
    doc.head.appendChild(el);
  }
  if (el.textContent !== GLANCE_NODE_MOTION_CSS) el.textContent = GLANCE_NODE_MOTION_CSS;
}
