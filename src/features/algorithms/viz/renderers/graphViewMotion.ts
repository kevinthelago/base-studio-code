// The `graph` viz kit's MOTION wiring (#3224, epic #3220/#2942) — injects the compiled motion CSS
// (frontier / visit / relax) into the live GraphView. SVG-safe properties only. The animation DATA now
// lives in a SHARED, feature-agnostic home (`@/shared/ui/kit/graphVizAnimations`, #3242) so BOTH consumers
// read ONE definition: this renderer AND the Designs `graph-viz` builtin kit — see that module's doc for
// the why and the state-trigger seam. The renderer's root carries the applying classes.
import { animClassName, compileAnimationsCss, kitAnimations } from "@/shared/ui/kit";
import { GRAPH_VIZ_KIT_ID, GRAPH_VIZ_ANIMATIONS } from "@/shared/ui/kit/graphVizAnimations";

// Re-export the shared data so this renderer's public surface (and the algorithms barrel) is unchanged.
export { GRAPH_VIZ_KIT_ID, GRAPH_VIZ_ANIMATIONS };

/** The applying classes the renderer's root carries so the state-scoped rules match its SVG elements. */
export const GRAPH_VIZ_ANIM_CLASSES: string = GRAPH_VIZ_ANIMATIONS.map((a) =>
  animClassName({ kit: GRAPH_VIZ_KIT_ID, name: a.name }),
).join(" ");

/** The compiled motion CSS — produced ONCE from {@link GRAPH_VIZ_ANIMATIONS}. Pure. */
export const GRAPH_VIZ_MOTION_CSS: string = compileAnimationsCss(
  kitAnimations([{ id: GRAPH_VIZ_KIT_ID, animations: GRAPH_VIZ_ANIMATIONS }]),
);

const STYLE_ID = "bsc-graph-viz-animations";

/** Inject the compiled graph motion CSS into a dedicated managed `<style>` (idempotent). `doc` param'd for
 *  tests. Mirrors `ensureArrayViewMotion` on its own style id. */
export function ensureGraphViewMotion(doc: Document = document): void {
  if (!GRAPH_VIZ_MOTION_CSS) return;
  let el = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = doc.createElement("style");
    el.id = STYLE_ID;
    doc.head.appendChild(el);
  }
  if (el.textContent !== GRAPH_VIZ_MOTION_CSS) el.textContent = GRAPH_VIZ_MOTION_CSS;
}
