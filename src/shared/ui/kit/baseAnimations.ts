// The `base` kit's MOTION library as DATA (#3451, epic #3260) — the base-studio-code app's OWN
// foundational animations (`lift` / `fade-in` / `pulse`) authored as {@link KitAnimation} data, compiled
// by the kit-motion engine (`compileAnimationsCss`) into `@keyframes bsc-base-<name>` + `.base-anim-<name>`.
//
// ── WHY A DEDICATED `base` KIT (not welded to `react-ui`) ────────────────────────────────────────────
// These three motions are a base vocabulary the whole platform leans on, but they lived inside the
// `react-ui` DEMO kit (its primitives' authored `animations`). That made one demo kit the owner of shared
// motion: any project adopting a different kit lost them, and the app's own UI couldn't reference them as
// shared graph nodes. They now live in ONE place — this kit — and every consumer (react-ui's Button /
// Card / StatusDot, and any future kit) REFERENCES them by name. Edit `lift` here once → every consumer's
// preview updates in lockstep, no regeneration. That shared resolution IS the propagation mechanic applied
// to motion (the resolver falls back to this kit for any name a consumer's own kit doesn't define —
// `resolveComponentAnimationDefs` in `features/designs/lib/model.ts`).
//
// ── WHY THIS LIVES IN shared/ui/kit ──────────────────────────────────────────────────────────────────
// Same reasoning as {@link file://./algoVizAnimations.ts}: it is genuinely feature-agnostic motion DATA
// with more than one consumer (the `manifest.ts` primitives that bind these names + the Designs `base`
// builtin kit), so it's a leaf both import cheaply — importing a feature barrel from the seed would risk a
// module cycle. The base kit is assembled from this const in `features/designs/lib/baseKit.ts` and seeded
// UNCONDITIONALLY (like the viz kits) so a consumer's reference always resolves.

import type { KitAnimation } from "./animations";

/** The base-motion kit id — `.base-anim-<name>` + `@keyframes bsc-base-<name>`. The store id (`bsc/base`)
 *  is added when the kit joins the Rust `bsc ui` store (a follow-up slice of #3451). */
export const BASE_KIT_ID = "base";

/**
 * The `base` kit's animations as DATA (#3451) — moved VERBATIM out of the `react-ui` manifest primitives
 * (Button's `lift`, Card's `fade-in`, StatusDot's `pulse`), so there is exactly ONE definition of each.
 * Token-based durations/easings; the engine wraps every applying rule in
 * `@media (prefers-reduced-motion: no-preference)`, so reduced-motion is handled for free. This is the
 * single source of truth the react-ui primitives (and any other kit) reference by name — never duplicated.
 */
export const BASE_ANIMATIONS: KitAnimation[] = [
  {
    name: "lift", trigger: "hover", duration: "var(--dur-fast)", easing: "var(--ease-standard)",
    keyframes: {
      from: { transform: "translateY(0)" },
      to: { transform: "translateY(-1px)" },
    },
  },
  {
    name: "fade-in", trigger: "mount", duration: "var(--dur-base)", easing: "var(--ease-emphasized)",
    keyframes: {
      from: { opacity: "0", transform: "translateY(4px)" },
      to: { opacity: "1", transform: "translateY(0)" },
    },
  },
  {
    name: "pulse", trigger: "always", duration: "var(--dur-slow)", easing: "var(--ease-standard)",
    keyframes: {
      "0%": { opacity: "1" },
      "50%": { opacity: "0.45" },
      "100%": { opacity: "1" },
    },
  },
];
