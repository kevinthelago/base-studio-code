// Public API barrel for the Algorithms knowledge-graph feature (#2761). The Workspace is the rail
// destination; the pure model (`knowledge`) is re-exported for consumers.
export { AlgorithmsWorkspace } from "./AlgorithmsWorkspace";
// #4219: the graph-hosted workspace — what the planner mounts. The file component above stays exported;
// both copies coexist under the record<->file parity guard.
export { AlgorithmsGraphHost } from "./AlgorithmsGraphHost";
// #4265: the project-planner lens on the algorithms library — the twin of the Design Studio's
// PlannerComponentsPane, so the planner presents BOTH halves of the artifact surface.
export { PlannerAlgorithmsPane } from "./PlannerAlgorithmsPane";
export * from "./lib/knowledge";
// The cross-graph adapter (#3116) — the algo-graph NodeLookup another pillar composes into its resolver.
export { algoNodeLookup } from "@/features/algorithms/lib/crossGraphAdapter";

// Algorithm-visualization foundation (#3176, epic #3171) — the trace-frame contract, the streaming
// engine, the verb→state binding helpers, the generic player, and the pluggable renderer registry the
// per-structure renderers (#3178–#3185) plug into.
export * from "@/features/algorithms/lib/trace";
export * from "@/features/algorithms/lib/binding";
export { makeTraceStream, DEFAULT_BUFFER_SIZE } from "@/features/algorithms/lib/traceStream";
export type { TraceStream, TraceStreamOptions } from "@/features/algorithms/lib/traceStream";
export { TracePlayer } from "./viz/TracePlayer";
export type { TracePlayerProps } from "./viz/TracePlayer";
export { fallbackRenderer, resolveRenderer } from "@/features/algorithms/viz/registry";
export type { StructureRenderer, RendererRegistry } from "@/features/algorithms/viz/registry";

// The `array` renderer (#3178) + the seeded sort proof (#3177) — the array proof-of-loop.
export { ArrayView } from "./viz/renderers/ArrayView";
// The array viz kit's MOTION as KitAnimation data (#2942) — compiled by the engine; exported so a
// future Designs kit-store integration can register + edit it in the AnimationsMenu (see the module's
// RESIDUAL note).
export { ALGO_VIZ_KIT_ID, ALGO_VIZ_ANIMATIONS, ALGO_VIZ_ANIM_CLASSES } from "@/features/algorithms/viz/renderers/arrayViewMotion";
export { sortSteps, sort, SORT_MOCK, parseSortInput } from "@/features/algorithms/viz/examples/sort";
// Instrumented execution (#3216) — the algorithm's real code drives the animation via the tracer.
export { TracedArray, runAlgorithm, TracedMatrix, runMatrixAlgorithm, TracedGraph, runGraphAlgorithm } from "@/features/algorithms/lib/tracer";
export type { ArrayMark, GraphInput, GraphMark, GraphRole, Neighbour, CellWrite } from "@/features/algorithms/lib/tracer";
export { TRACE_PROGRAMS, programKey, programForImpl, type AlgoProgram } from "@/features/algorithms/viz/examples/sorts";
// Array SEARCH (#3220) — the `probe`/`found` vocabulary over the SAME ArrayView the sorts use.
export { SEARCH_PROGRAMS, linearSearch, binarySearch, parseSearchInput, searchToText } from "@/features/algorithms/viz/examples/searches";
export type { SearchInput, SearchProgram } from "@/features/algorithms/viz/examples/searches";
// The `scalar` datatype (#3220) — renderer + the accumulate programs (fibonacci).
export { ScalarView } from "./viz/renderers/ScalarView";
export { TracedScalar, runScalarAlgorithm } from "@/features/algorithms/lib/tracer";
export { SCALAR_PROGRAMS, fibonacci, parseScalarInput, scalarToText, type ScalarProgram } from "@/features/algorithms/viz/examples/scalarAlgos";
// The `matrix` datatype (#3221, epic #3220) — renderer + transform programs.
export { MatrixView } from "./viz/renderers/MatrixView";
export { MATRIX_PROGRAMS, parseMatrixInput, matrixToText, type MatrixProgram } from "@/features/algorithms/viz/examples/matrixTransforms";
// The `graph` datatype (#3224, epic #3220) — renderer + traversal/shortest-path programs.
export { GraphView } from "./viz/renderers/GraphView";
export { circularLayout, coordinateLayout, layoutFor } from "@/features/algorithms/viz/renderers/graphLayout";
export { GRAPH_PROGRAMS, parseGraphInput, graphToText, type GraphProgram } from "@/features/algorithms/viz/examples/graphAlgos";
export { programVizForImpl, resolveVizExample, resolveKind } from "./viz/examples/registry";
export { useVizForImpl } from "@/features/algorithms/viz/useVizForImpl";
export { classifyKind, type Classifiable } from "@/features/algorithms/lib/classifyKind";
export type { VizExample } from "./viz/examples/registry";
// Studio network (#2940): run an impl's vizCode in the sandbox → a normalized dataset a component
// preview can bind to (the algorithms-drive-previews payoff).
export { runInSandbox } from "./viz/examples/vizSandbox";
export type { VizRun } from "./viz/examples/vizProgram";
export { vizRunToDataset } from "@/features/algorithms/viz/vizDataset";
export type { VizDataset } from "@/features/algorithms/viz/vizDataset";
// Shape tier (#3439): a synchronous real dataset for a target structure (array / graph), sourced from a
// canonical in-app trace program — feeds the Design Studio's DataShape-driven preview data.
export { datasetForStructure, type PreviewStructure } from "@/features/algorithms/viz/previewDataset";
