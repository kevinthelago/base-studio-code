// Public API barrel for the Algorithms knowledge-graph feature (#2761). The Workspace is the rail
// destination; the pure model is re-exported so Phase 2 (extraction, #2745) can map code onto these
// concepts without reaching into internals.
export { AlgorithmsWorkspace } from "./AlgorithmsWorkspace";
export * from "./lib/knowledge";
export * from "./lib/extraction";
export * from "./lib/compositionDiff";
