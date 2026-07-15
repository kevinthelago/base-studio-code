// Public API barrel for the Algorithms knowledge-graph feature (#2761). The Workspace is the rail
// destination; the pure model (`knowledge`) is re-exported for consumers.
export { AlgorithmsWorkspace } from "./AlgorithmsWorkspace";
export * from "./lib/knowledge";
// The cross-graph adapter (#3116) — the algo-graph NodeLookup another pillar composes into its resolver.
export { algoNodeLookup } from "./lib/crossGraphAdapter";
