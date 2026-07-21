// The DEBUG session feature (epic #3260) — an app-owned, full-capability Claude session in the
// base-studio-code SOURCE tree that works the `bsc request` improvement queue (fixing `bsc ui`). It is
// surfaced as the `debugger` node in the base-studio-code Glance graph (#3319/#3322), shown only when the
// Settings `debugSession` flag is on. The separate OS window (#3298) was removed in #3327; the terminal
// now lives on the app-level TerminalHost (#3326) — kept warm by `DebugSessionMount` and shown in the
// in-graph morph when the node is opened.
export { DebugSessionMount, DEBUG_PANE_ID } from "./DebugSessionMount";
// #3535: the standing debug session is the always-on primary; RequestSessionsMount is the paced,
// capped OVERFLOW pool beside it. Inert unless the Settings auto-spawn toggle is on (off by default).
export { RequestSessionsMount } from "./RequestSessionsMount";
export { poolPaneId, poolCharter } from "./requestSession";
