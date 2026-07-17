// The `tree-viz` kit's MOTION library as DATA (#3270, epic #3171/#2942) — the insert / swap / visit /
// compare animations for the tree/heap renderer, authored as {@link KitAnimation} data and compiled by the
// kit-motion engine. SVG-safe properties only (stroke / stroke-width / opacity / transform), since TreeView
// draws nodes + edges as SVG — the tree twin of the graph motion set.
//
// ── WHY THIS LIVES IN shared/ui/kit ──────────────────────────────────────────────────────────────────
// Like the array (#3194) + matrix/graph (#3242) + stack/scalar (#3266/#3268) sets: two consumers in two
// features, one definition — the Algorithms TreeView renderer (`features/algorithms/.../treeViewMotion.ts`)
// injects the compiled CSS, and the Designs seed can register `tree-viz` as a recoverable builtin kit (a
// later slice). Feature-agnostic viz-motion, so it lives HERE to avoid a designs↔algorithms cycle.
//
// STATE-TRIGGER SEAM (#3058): each selector IS the transient data-op TreeView stamps on the node circle
// (`[data-op="insert"]`, …) — the DURABLE node states (current/path/target) are static colours in
// treeView.css; these are the one-shot transitions.

import type { KitAnimation } from "./animations";

/** The tree-visualization motion kit id — `.tree-viz-anim-<name>` + `@keyframes bsc-tree-viz-<name>`. */
export const TREE_VIZ_KIT_ID = "tree-viz";

/** The tree kit's animations as DATA — insert (a new node scales + fades in at its slot), swap (the two
 *  sift nodes flash their outline as their values exchange), visit (a pop as a node is touched/extracted),
 *  compare (a brief outline pulse on a read). SVG-safe; the engine wraps each in
 *  `prefers-reduced-motion: no-preference`. The single source the TreeView renderer + the (later) `tree-viz`
 *  Designs kit both consume. */
export const TREE_VIZ_ANIMATIONS: KitAnimation[] = [
  // insert — a new node scales up + fades in as it joins the tree.
  {
    name: "insert",
    selector: '[data-op="insert"]',
    duration: "420ms",
    easing: "cubic-bezier(0.34, 1.4, 0.5, 1)",
    keyframes: {
      "0%": { transform: "scale(0.4)", opacity: "0.2", stroke: "var(--accent)" },
      "100%": { transform: "scale(1)", opacity: "1" },
    },
  },
  // swap — the two nodes whose values exchange (the heap sift) flash their outline.
  {
    name: "swap",
    selector: '[data-op="swap"]',
    duration: "440ms",
    easing: "var(--ease-standard)",
    keyframes: {
      "0%": { stroke: "var(--accent)", "stroke-width": "3.5", transform: "scale(1.12)" },
      "100%": { "stroke-width": "1.5", transform: "scale(1)" },
    },
  },
  // visit — the node pops as it's touched / extracted as the min.
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
  // compare — a brief outline pulse on a read that leaves the tree unchanged.
  {
    name: "compare",
    selector: '[data-op="compare"]',
    duration: "460ms",
    easing: "var(--ease-standard)",
    keyframes: {
      "0%": { "stroke-width": "1.5" },
      "45%": { "stroke-width": "4", stroke: "var(--state-wait)" },
      "100%": { "stroke-width": "1.5" },
    },
  },
];
