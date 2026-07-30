// The `glance-node` kit's MOTION library as DATA (#4032, epic #2942) — the fleet node's live states
// authored as {@link KitAnimation} data and compiled by the kit-motion engine, instead of the raw
// keyframe + inline style they were.
//
// ── WHY THIS LIVES IN shared/ui/kit ──────────────────────────────────────────────────────────────
// The same reason the array / graph / matrix viz sets do (#3242): two consumers, one definition. Here
// they are the live `GlanceNode` renderer and the designer, which reads the registered component
// record. Feature-agnostic motion belongs where neither feature owns it.
//
// ── WHY `trigger: "always"` ──────────────────────────────────────────────────────────────────────
// These are STATE animations: they play for as long as the node is in the state, unlike the viz kits'
// one-shot transitions. The engine already models that — `compileAnimationsCss` emits `infinite` for
// an `always` trigger — so nothing about the schema had to change to express them. Nobody had simply
// authored one before: the store held 254 component records and ZERO motion.
//
// ── WHY THERE IS NO `complete` ENTRY ─────────────────────────────────────────────────────────────
// Its stillness IS the statement. The node vocabulary is: building BREATHES, attention RINGS, complete
// is STILL — motion means "look at this", and a finished worker is the one state with nothing to do
// about it. The absence of an entry is how that reads as data, so a designer adding one is making a
// deliberate change rather than filling a gap.

import type { KitAnimation } from "./animations";

/** The fleet-node motion kit id — `.glance-node-anim-<name>` + `@keyframes bsc-glance-node-<name>`. */
export const GLANCE_NODE_KIT_ID = "glance-node";

/**
 * The fleet node's state motion as DATA. Bound to the `data-node-state` attribute `GlanceNode` stamps,
 * so the selector IS the state — no class bookkeeping, and a designer reading the record can see which
 * state each animation belongs to.
 */
export const GLANCE_NODE_ANIMATIONS: KitAnimation[] = [
  // BUILDING — the node breathes while the worker is actively working.
  //
  // Shallow (1 → .78) and slower than the status dot (1.8s vs 1.4s), both deliberately: the dot's .45
  // floor applied to a whole node reads as BROKEN rather than busy, and a row of workers dipping that
  // far in unison is unpleasant to look at. This is the one animation a whole fleet may run at once.
  {
    name: "building",
    selector: '[data-node-state="building"]',
    trigger: "always",
    duration: "1800ms",
    easing: "ease-in-out",
    keyframes: {
      "0%": { opacity: "1" },
      "50%": { opacity: "0.78" },
      "100%": { opacity: "1" },
    },
  },
  // ATTENTION — the node pulses a ring while it is blocked on a PERSON.
  //
  // Stronger and faster than the breath on purpose: this is the one state that needs someone, and
  // before #4015 it was the LEAST prominent thing in the cockpit — a busy node was more visually
  // insistent than a stuck one. `box-shadow` rather than a border so it cannot fight the border's
  // existing precedence chain (selected → preview → off → error → cycle).
  {
    name: "attention",
    selector: '[data-node-state="attention"]',
    trigger: "always",
    duration: "1400ms",
    easing: "ease-in-out",
    keyframes: {
      "0%": { "box-shadow": "0 0 0 0 var(--graph-health-attention)" },
      "60%": { "box-shadow": "0 0 0 4px transparent" },
      "100%": { "box-shadow": "0 0 0 0 transparent" },
    },
  },
];
