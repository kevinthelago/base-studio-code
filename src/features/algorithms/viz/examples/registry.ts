// The impl → visualization registry (#3177, epic #3171) — the lookup the Algorithms inspector uses to
// decide whether a focused implementation has a live Visualization pane, and, if so, WHAT to play. For
// the array proof-of-loop this maps exactly the seeded `sort.ts` impl to its trace factory + the
// <ArrayView> renderer.
//
// SCOPE (a scoped-out follow-up): today the example generators are in-app modules (the plain fn + the
// step-yielding trace, colocated). The durable end state is running a STORE-authored generator (the
// librarian's `code`) through the shared preview iframe (`shared/lib/preview/`, #3177) so any library
// impl animates without an in-app module. This registry is the seam that swaps to that: the inspector
// asks `vizForImpl(id)` and renders a player; only the RESOLVER changes when store-authored generators
// execute in the iframe.

import type { Frame } from "../../lib/trace";
import type { RendererRegistry } from "../registry";
import { ArrayView } from "../renderers/ArrayView";
import { SORT_MOCK, sortSteps } from "./sort";

/** A ready-to-play visualization for one implementation: a memoizable factory (a fresh, deterministic
 *  trace generator per call) + the per-structure renderers the player dispatches to. */
export interface VizExample {
  /** Produces a fresh trace generator from the impl's fixed mock input. STABLE identity (defined once
   *  here), so the inspector can hand it straight to `<TracePlayer factory>` without re-memoizing. */
  factory: () => Generator<Frame>;
  /** The renderers this example needs (array → {@link ArrayView}). */
  renderers: RendererRegistry;
}

/** The impls that have a live Visualization pane, keyed by impl id. The array sort proof (#3178/#3177).
 *  `sortSteps` mutates its input in place, so the factory hands it a FRESH COPY of the immutable
 *  {@link SORT_MOCK} each call — keeping the mock pristine so the engine's deterministic replay is exact. */
export const VIZ_EXAMPLES: Record<string, VizExample> = {
  "sort.ts": {
    factory: () => sortSteps([...SORT_MOCK]),
    renderers: { array: ArrayView },
  },
};

/** The visualization for an implementation id, or `undefined` when it has none (no Visualization pane).
 *  Pure lookup — the inspector shows the Code | Visualization toggle only when this is defined. */
export function vizForImpl(id: string): VizExample | undefined {
  return VIZ_EXAMPLES[id];
}
