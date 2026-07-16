// The `graph` viz kit's MOTION (#3224, epic #3220/#2942) — the frontier / visit / relax animations as
// KitAnimation DATA, compiled by the kit-motion engine. SVG-safe properties only (stroke / stroke-width /
// opacity / transform), since the renderer draws nodes + edges as SVG. State-triggered (#3058): each
// selector IS the transient data-op the GraphView stamps (`[data-op="visit"]`, …) — the DURABLE node
// states (visited / frontier / current) are static colours in graphView.css; these are the one-shot
// transitions into them. The renderer's root carries the applying classes.
import { animClassName, compileAnimationsCss, kitAnimations, type KitAnimation } from "@/shared/ui/kit";

/** The graph-visualization motion kit id — `.graph-viz-anim-<name>` + `@keyframes bsc-graph-viz-<name>`. */
export const GRAPH_VIZ_KIT_ID = "graph-viz";

/** The graph kit's animations as DATA — frontier (a node ring pulse as it's discovered), visit (a pop as a
 *  node is finished), relax (an edge flash as it's traversed). SVG-safe; the engine wraps each in
 *  `prefers-reduced-motion: no-preference`. */
export const GRAPH_VIZ_ANIMATIONS: KitAnimation[] = [
  // frontier — the node's outline pulses as it enters the frontier.
  {
    name: "frontier",
    selector: '[data-op="frontier"]',
    duration: "480ms",
    easing: "var(--ease-standard)",
    keyframes: {
      "0%": { "stroke-width": "1.5" },
      "45%": { "stroke-width": "4.5", stroke: "var(--state-wait)" },
      "100%": { "stroke-width": "1.5" },
    },
  },
  // visit — the node pops as it's finished (transform-box: fill-box in the CSS keeps it centred).
  {
    name: "visit",
    selector: '[data-op="visit"]',
    duration: "420ms",
    easing: "cubic-bezier(0.34, 1.4, 0.5, 1)",
    keyframes: {
      "0%": { transform: "scale(1.34)" },
      "100%": { transform: "scale(1)" },
    },
  },
  // relax — the edge flashes to the accent as it's traversed.
  {
    name: "relax",
    selector: '[data-op="relax"]',
    duration: "460ms",
    easing: "var(--ease-standard)",
    keyframes: {
      "0%": { stroke: "var(--accent)", "stroke-width": "3.5" },
      "100%": { "stroke-width": "1.5" },
    },
  },
];

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
