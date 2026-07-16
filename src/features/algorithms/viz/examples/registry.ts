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
import { SORT_MOCK, sortSteps, parseSortInput } from "./sort";

/** A ready-to-play visualization for one implementation: a stable default factory (the inline preview) +
 *  the per-structure renderers the player dispatches to + an editable INPUT seam (#3199) that powers the
 *  fullscreen "provide your own state" field. */
export interface VizExample {
  /** Produces a fresh trace generator from the impl's fixed mock input. STABLE identity (defined once
   *  here), so the inspector can hand it straight to `<TracePlayer factory>` without re-memoizing. */
  factory: () => Generator<Frame>;
  /** The renderers this example needs (array → {@link ArrayView}). */
  renderers: RendererRegistry;
  /** The editable input driving the trace (#3199) — the "state" the user provides in the fullscreen view.
   *  `parse` turns the field text into typed input (throwing a helpful Error on invalid input); `make`
   *  builds a FRESH trace from it. `make(parse(default))` reproduces `factory`'s trace. `parse`/`make`
   *  share one input type per example; the seam is `unknown` here so the registry can hold mixed shapes. */
  input: {
    /** Default input as text, seeding the fullscreen field. */
    default: string;
    /** A short hint shown under the field (what to type). */
    hint: string;
    /** Parse the field text into typed input; throws an `Error` (message shown to the user) on invalid. */
    parse: (text: string) => unknown;
    /** Build a fresh trace generator from parsed input — a fresh copy per call, so replay stays exact. */
    make: (parsed: unknown) => Generator<Frame>;
  };
}

/** The impls that have a live Visualization pane, keyed by impl id. The array sort proof (#3178/#3177).
 *  `sortSteps` mutates its input in place, so both `factory` and `input.make` hand it a FRESH COPY (of the
 *  immutable {@link SORT_MOCK} / the parsed input) each call — keeping the source pristine so the engine's
 *  deterministic replay is exact. */
export const VIZ_EXAMPLES: Record<string, VizExample> = {
  "sort.ts": {
    factory: () => sortSteps([...SORT_MOCK]),
    renderers: { array: ArrayView },
    input: {
      default: SORT_MOCK.join(", "),
      hint: "Comma- or space-separated numbers to sort",
      parse: (text) => parseSortInput(text),
      make: (parsed) => sortSteps([...(parsed as number[])]),
    },
  },
};

/** The visualization for an implementation id, or `undefined` when it has none (no Visualization pane).
 *  Pure lookup — the inspector shows the Code | Visualization toggle only when this is defined. */
export function vizForImpl(id: string): VizExample | undefined {
  return VIZ_EXAMPLES[id];
}
