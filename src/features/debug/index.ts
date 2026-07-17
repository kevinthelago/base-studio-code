// The DEBUG session feature (epic #3260) — an app-owned, full-capability Claude session in the
// base-studio-code SOURCE tree that works the `bsc request` improvement queue (fixing `bsc ui`). It is
// surfaced as the `debugger` node in the base-studio-code Glance graph (#3319/#3322), shown only when the
// Settings `debugSession` flag is on. (The separate OS window — #3298 — was removed in #3327; the terminal
// moves onto the app-level TerminalHost for the in-graph morph in slice 2 / #3326.)
export { useDebugTerminal, DEBUG_PANE_ID } from "./useDebugTerminal";
