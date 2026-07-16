// Public API barrel for the Algorithms knowledge-graph feature (#2761). The Workspace is the rail
// destination; the pure model (`knowledge`) is re-exported for consumers.
export { AlgorithmsWorkspace } from "./AlgorithmsWorkspace";
export * from "./lib/knowledge";
// The cross-graph adapter (#3116) — the algo-graph NodeLookup another pillar composes into its resolver.
export { algoNodeLookup } from "./lib/crossGraphAdapter";

// Algorithm-visualization foundation (#3176, epic #3171) — the trace-frame contract, the streaming
// engine, the verb→state binding helpers, the generic player, and the pluggable renderer registry the
// per-structure renderers (#3178–#3185) plug into.
export * from "./lib/trace";
export * from "./lib/binding";
export { makeTraceStream, DEFAULT_BUFFER_SIZE } from "./lib/traceStream";
export type { TraceStream, TraceStreamOptions } from "./lib/traceStream";
export { TracePlayer } from "./viz/TracePlayer";
export type { TracePlayerProps } from "./viz/TracePlayer";
export { fallbackRenderer, resolveRenderer } from "./viz/registry";
export type { StructureRenderer, RendererRegistry } from "./viz/registry";

// The `array` renderer (#3178) + the seeded sort proof (#3177) — the array proof-of-loop.
export { ArrayView } from "./viz/renderers/ArrayView";
// The array viz kit's MOTION as KitAnimation data (#2942) — compiled by the engine; exported so a
// future Designs kit-store integration can register + edit it in the AnimationsMenu (see the module's
// RESIDUAL note).
export { ALGO_VIZ_KIT_ID, ALGO_VIZ_ANIMATIONS, ALGO_VIZ_ANIM_CLASSES } from "./viz/renderers/arrayViewMotion";
export { sortSteps, sort, SORT_MOCK } from "./viz/examples/sort";
export { vizForImpl, resolveKind, EXAMPLES_BY_KIND } from "./viz/examples/registry";
export { classifyKind, type Classifiable } from "./lib/classifyKind";
export type { VizExample } from "./viz/examples/registry";
