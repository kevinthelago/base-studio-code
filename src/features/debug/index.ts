// The shadow catalogue registers this feature's graph-platform modules by importing
// `./graphPlatform` DIRECTLY and calling its register function (see `shadowPages.ts`). This barrel
// therefore has NO import-time side effect — it is re-exports only, which is what lets it be a
// record rather than a file that must run to be correct.

// The DEBUG session feature (epic #3260) — app-owned, full-capability Claude sessions in the
// base-studio-code SOURCE tree that work the `bsc request` improvement queue (fixing `bsc ui`).
//
// ONE SESSION PER REQUEST, and nothing else (#one-request-one-debug-session, unconditional in
// #debug-nodes-hang-off-the-session-that-filed-them). The standing `debugger` session and its node are
// gone: it was an idle stand-in for work that now shows itself, and a second claimant on the same
// queue. Each live session is a node in the Glance graph, labelled with its request and edged to the
// session that filed it — so an auto-started session is always visible, openable and stoppable.
export { RequestSessionsMount } from "./RequestSessionsMount";
export { requestPaneId, requestCharter, originLabel, DEBUG_INIT_CMD, DEBUG_ROLE_PROMPT } from "@/features/debug/requestSession";
