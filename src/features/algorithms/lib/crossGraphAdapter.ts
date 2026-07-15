// Cross-graph adapter (#3116, epic #3114) — the Algorithms feature's map from its OWN store shape onto
// the feature-agnostic {@link NodeLookup} the shared cross-graph resolver composes. The three pillars
// stay decoupled: `shared/lib/graph/crossGraph` knows nothing about an `AlgoImpl`; THIS module adapts it,
// and the consumer (the Design Studio preview + component graph) wires it via `makeUrnResolver`. Pure +
// React-free.
//
// A node URN's `kit` is, for the algo graph, a language `Tech` (`typescript`/`rust`) and its `id` is the
// in-kit impl id (`fibonacci.ts`) OR the bare name (`fibonacci`) — the lookup accepts EITHER, because a
// component author writes the kit-less `@bsc/algorithms/fibonacci` and the store resolves it. `code` is the
// reusable implementation the preview vendors (absent for a primitive descriptor, which is not importable).
import type { NodeLookup, ResolvedNode } from "@/shared/lib/graph/crossGraph";
import { KNOWLEDGE, type KnowledgeGraph } from "./knowledge";

/**
 * A {@link NodeLookup} over the algorithms store for the `algo` graph. Given a `kit` (a language `Tech`)
 * and an in-kit `id` — the exact impl id (`fibonacci.ts`) OR the bare name (`fibonacci`) — resolve to the
 * matching implementation, or `null`. Defaults to the packaged {@link KNOWLEDGE} seed; a caller can pass
 * the live-hydrated graph. The returned node's `urn`/`graph`/`kit`/`id` are placeholders — `makeUrnResolver`
 * overwrites them from the URN — so only `label`/`kind`/`code` carry through (`id` is set to the impl's
 * CANONICAL id so a caller can canonicalize the URN).
 */
export function algoNodeLookup(graph: KnowledgeGraph = KNOWLEDGE): NodeLookup {
  return (kit: string, id: string): ResolvedNode | null => {
    const impl = graph.implementations.find(
      (im) => im.tech === kit && (im.id === id || im.name === id),
    );
    if (!impl) return null;
    return {
      urn: "",
      graph: "algo",
      kit,
      id: impl.id,
      label: impl.name,
      kind: impl.role,
      code: impl.code,
    };
  };
}
