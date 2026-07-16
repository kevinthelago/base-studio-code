// The kind → visualization registry (#3177/#3210, epic #3171/#3209) — the lookup the Algorithms inspector
// uses to decide whether a focused implementation has a live Visualization pane, and, if so, WHAT to play.
//
// KEYED BY KIND, NOT BY ID (#3210): an example is registered per MANIPULATION kind (`sort`/`search`/…),
// and `vizForImpl` resolves an impl's kind (its assigned `kind`, else the heuristic classifier) and plays
// that kind's example. So one `sort` example lights up the WHOLE sort family (bubble/merge/quick/heap/…),
// not just `sort.ts` — the category-representative animation, per the epic's "driven by the data
// structure, not per-algorithm" vision.
//
// SCOPE (a scoped-out follow-up): today the example generators are in-app modules (the plain fn + the
// step-yielding trace, colocated). The durable end state is running a STORE-authored generator (the
// librarian's `code`) through the shared preview iframe (`shared/lib/preview/`, #3177) so any library
// impl animates without an in-app module.

import type { Frame } from "../../lib/trace";
import type { AlgoImpl, AlgoKind } from "../../lib/knowledge";
import { classifyKind, type Classifiable } from "../../lib/classifyKind";
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

/** The example animation for each MANIPULATION kind (#3210). Only `sort` exists today (the array proof,
 *  #3178); search/traversal/accumulate land in S2 (#3211). A `Partial` map — a kind with no example yet
 *  simply has no animation. `sortSteps` mutates in place, so `factory`/`input.make` hand it a FRESH COPY
 *  (of the immutable {@link SORT_MOCK} / the parsed input) each call, keeping replay deterministic. */
export const EXAMPLES_BY_KIND: Partial<Record<AlgoKind, VizExample>> = {
  sort: {
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

/** Resolve an implementation's kind (#3210): the CREATOR-assigned `kind` wins; otherwise the heuristic
 *  classifier infers it. `null` when neither yields a kind (an untyped, unclassifiable impl). */
export function resolveKind(impl: Pick<AlgoImpl, "kind"> & Classifiable): AlgoKind | null {
  return impl.kind ?? classifyKind(impl);
}

/** The visualization for an implementation, or `undefined` when its kind has no example (or it has no
 *  resolvable kind). Pure lookup over the resolved kind — the inspector renders the inline visualization
 *  only when this is defined (#3199). So the whole sort family animates off the one `sort` example. */
export function vizForImpl(impl: Pick<AlgoImpl, "kind"> & Classifiable): VizExample | undefined {
  const kind = resolveKind(impl);
  return kind ? EXAMPLES_BY_KIND[kind] : undefined;
}
