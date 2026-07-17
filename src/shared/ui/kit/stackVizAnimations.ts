// The `stack-viz` kit's MOTION library as DATA (#3266, epic #3171/#2942) — the push / pop / peek
// animations for the stack/queue/deque renderer, authored as {@link KitAnimation} data and compiled by
// the kit-motion engine. The FIFO/LIFO twin of the array/matrix/graph motion sets.
//
// ── WHY THIS LIVES IN shared/ui/kit ──────────────────────────────────────────────────────────────────
// Like the array (#3194) + matrix/graph (#3242) sets: two consumers in two features, one definition — the
// Algorithms StackView renderer (`features/algorithms/.../stackViewMotion.ts`) injects the compiled CSS,
// and the Designs seed can register `stack-viz` as a recoverable builtin kit (a later slice). Feature-
// agnostic viz-motion, so it lives HERE to avoid a designs↔algorithms cycle.
//
// STATE-TRIGGER SEAM (#3058): each selector IS the data-state StackView stamps on the active-end cell
// (`[data-op="push"]`, …) — so a rule fires exactly when a cell enters/leaves the active end.

import type { KitAnimation } from "./animations";

/** The stack-visualization motion kit id — `.stack-viz-anim-<name>` + `@keyframes bsc-stack-viz-<name>`. */
export const STACK_VIZ_KIT_ID = "stack-viz";

/** The stack kit's animations as DATA — push (a cell drops in at the active end), pop (the cell leaving
 *  flashes as it goes), peek (a ring on the inspected cell). Token-based; the engine wraps each in
 *  `prefers-reduced-motion: no-preference`. The single source the StackView renderer + the (later)
 *  `stack-viz` Designs kit both consume. */
export const STACK_VIZ_ANIMATIONS: KitAnimation[] = [
  // push — a new entry drops in at the active end (scales up + fades in from the top).
  {
    name: "push",
    selector: '[data-op="push"]',
    duration: "420ms",
    easing: "cubic-bezier(0.34, 1.4, 0.5, 1)",
    set: { "z-index": "2" },
    keyframes: {
      "0%": { transform: "translateY(-10px) scale(0.7)", opacity: "0.25", "border-color": "var(--accent)" },
      "100%": { transform: "translateY(0) scale(1)", opacity: "1" },
    },
  },
  // pop — the entry now exposed at the active end flashes as the top one leaves.
  {
    name: "pop",
    selector: '[data-op="pop"]',
    duration: "400ms",
    easing: "var(--ease-standard)",
    keyframes: {
      "0%": { "border-color": "var(--accent)", background: "color-mix(in oklch, var(--accent), var(--bg-elev) 60%)" },
      "100%": { background: "var(--bg-elev)" },
    },
  },
  // peek — a quick ring on the inspected cell (a read that doesn't move the ends).
  {
    name: "peek",
    selector: '[data-op="peek"]',
    duration: "450ms",
    easing: "var(--ease-standard)",
    set: { "z-index": "1" },
    keyframes: {
      "0%": { "box-shadow": "0 0 0 0 transparent" },
      "45%": { "box-shadow": "0 0 0 2px color-mix(in oklch, var(--state-wait), transparent 45%)" },
      "100%": { "box-shadow": "0 0 0 0 transparent" },
    },
  },
];
