// The `graph-viz` kit's MOTION library as DATA (#3224/#3242, epic #3220/#2942) — the frontier / visit /
// relax animations authored as {@link KitAnimation} data, compiled by the kit-motion engine. SVG-safe
// properties only (stroke / stroke-width / opacity / transform), since GraphView draws nodes + edges as SVG.
//
// ── WHY THIS LIVES IN shared/ui/kit ──────────────────────────────────────────────────────────────────
// Same as the array (#3194) + matrix sets: two consumers in two features, one definition — the Algorithms
// GraphView renderer (`features/algorithms/.../graphViewMotion.ts`) and the Designs seed
// (`features/designs/lib/graphVizKit.ts` → `seed.ts`, which registers `graph-viz` as a recoverable builtin
// kit). Feature-agnostic viz-motion, so it lives HERE to avoid a designs↔algorithms seed cycle (#3242).
//
// STATE-TRIGGER SEAM (#3058): each selector IS the transient data-op GraphView stamps
// (`[data-op="visit"]`, …) — the DURABLE node states (visited / frontier / current) are static colours in
// graphView.css; these are the one-shot transitions into them.

import type { KitAnimation } from "./animations";

/** The graph-visualization motion kit id — `.graph-viz-anim-<name>` + `@keyframes bsc-graph-viz-<name>`. */
export const GRAPH_VIZ_KIT_ID = "graph-viz";

/** The graph kit's animations as DATA — frontier (a node ring pulse as it's discovered), visit (a pop as a
 *  node is finished), relax (an edge flash as it's traversed). SVG-safe; the engine wraps each in
 *  `prefers-reduced-motion: no-preference`. The single source of truth the GraphView renderer AND the
 *  Designs `graph-viz` builtin kit both consume. */
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
