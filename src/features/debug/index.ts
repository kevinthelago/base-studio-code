// The DEBUG session feature (#3298, epic #3260) — an app-owned, full-capability Claude session in the
// base-studio-code SOURCE tree that works the `bsc request` improvement queue (fixing `bsc ui`). Public
// API barrel: the window-hosted terminal, the window open/close helpers, and the `?debug=1` predicate.
export { DebugTerminal } from "./DebugTerminal";
export { openDebugWindow, closeDebugWindow, detachedDebug, DEBUG_WINDOW_LABEL } from "./debugWindow";
export { DEBUG_PANE_ID } from "./useDebugTerminal";
