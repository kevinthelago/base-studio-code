// The `tree` viz kit's MOTION wiring (#3270, epic #3220/#2942) — injects the compiled motion CSS
// (insert / swap / visit / compare) into the live TreeView. The animation DATA lives in a SHARED,
// feature-agnostic home (`@/shared/ui/kit/treeVizAnimations`) so BOTH consumers read ONE definition: this
// renderer AND a (later) `tree-viz` Designs builtin kit. `TreeView`'s root carries the applying classes
// ({@link TREE_VIZ_ANIM_CLASSES}); its node circles only stamp `data-op`. Mirrors graphViewMotion.
import { animClassName, compileAnimationsCss, kitAnimations } from "@/shared/ui/kit";
import { TREE_VIZ_KIT_ID, TREE_VIZ_ANIMATIONS } from "@/shared/ui/kit/treeVizAnimations";

// Re-export the shared data so this renderer's public surface (and the algorithms barrel) is unchanged.
export { TREE_VIZ_KIT_ID, TREE_VIZ_ANIMATIONS };

/** The applying classes the renderer's root carries so the state-scoped rules match its node circles. */
export const TREE_VIZ_ANIM_CLASSES: string = TREE_VIZ_ANIMATIONS.map((a) =>
  animClassName({ kit: TREE_VIZ_KIT_ID, name: a.name }),
).join(" ");

/** The compiled motion CSS — produced ONCE from {@link TREE_VIZ_ANIMATIONS}. Pure. */
export const TREE_VIZ_MOTION_CSS: string = compileAnimationsCss(
  kitAnimations([{ id: TREE_VIZ_KIT_ID, animations: TREE_VIZ_ANIMATIONS }]),
);

const STYLE_ID = "bsc-tree-viz-animations";

/** Inject the compiled tree motion CSS into a dedicated managed `<style>` (idempotent). `doc` param'd for
 *  tests. Mirrors `ensureGraphViewMotion` on its own style id. */
export function ensureTreeViewMotion(doc: Document = document): void {
  if (!TREE_VIZ_MOTION_CSS) return;
  let el = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = doc.createElement("style");
    el.id = STYLE_ID;
    doc.head.appendChild(el);
  }
  if (el.textContent !== TREE_VIZ_MOTION_CSS) el.textContent = TREE_VIZ_MOTION_CSS;
}
