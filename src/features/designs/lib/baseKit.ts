// The `base` builtin kit assembly (#3451, epic #3260) — registers the base-studio-code app's own
// foundational MOTION library (`lift` / `fade-in` / `pulse`) as a RECOVERABLE builtin kit in the Designs
// store, so the base animations are VISIBLE + EDITABLE in the Design Studio (its AnimationsMenu) and
// self-heal if deleted. This is the first concrete step toward "the app's own UI as a graph": the base
// motions become shared graph DATA that every kit references, not motion welded to one demo kit.
//
// WHY A SEPARATE SEAM FROM `makeBuiltinKits` — same reason as `algoVizKit.ts`: this kit's motion IS a TS
// constant (`BASE_ANIMATIONS`, the SAME data the react-ui primitives reference by name — reused, never
// duplicated), and a packaged JSON kit cannot reference a TS const. It's assembled in code here and
// `seed.ts` seeds it UNCONDITIONALLY (like the viz kits) — a consumer's animation reference must resolve
// even while `DEFAULT_KIT_SEEDED` (the react-ui default, #3029) is off, or the react-ui primitives would
// lose their now-base-owned motion. It is recoverable + shadow-proof via the #2483 reconcile, exactly
// like the viz kits.
//
// MOTION-ONLY (no demo component): the base animations are already demonstrated live by react-ui's
// Button / Card / StatusDot (which bind `lift` / `fade-in` / `pulse` by name and resolve them here), so
// the base kit is a pure motion library — its `animations` shelf is what the AnimationsMenu lists.
import { BASE_KIT_ID, BASE_ANIMATIONS } from "@/shared/ui/kit/baseAnimations";
import type { ComponentRecord, Kit } from "./model";
import { stampSeedHash } from "./seedRefresh";

/** The `base` builtin kit — a motion-only library (no components). It gets its OWN `style` ("motion")
 *  rather than joining react-ui's "studio": a `style` is a structurally different COMPONENT SET (a
 *  visual language), and a shared motion library is not one — filing it under react-ui's language
 *  would both misdescribe it and collapse studio's single-kit rail header. `animations` is the SAME
 *  reference as {@link BASE_ANIMATIONS} through the shallow stamp (one definition, no copy). */
export function makeBaseKit(): { kits: Kit[]; components: ComponentRecord[] } {
  const kit: Kit = {
    id: BASE_KIT_ID,
    name: "Base",
    tech: "react",
    style: "motion",
    stack: "base-studio-code",
    dot: "var(--accent)",
    animations: BASE_ANIMATIONS,
    builtin: true,
  };
  return { kits: [stampSeedHash(kit)], components: [] };
}
