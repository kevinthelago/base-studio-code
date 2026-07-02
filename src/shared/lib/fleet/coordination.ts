// Inter-session coordination core (#199) — the public barrel.
//
// The coord-log event model was decomposed into colocated concern-modules (#2148) while
// this file stays the single public import surface: `@/shared/lib/fleet/coordination` keeps
// re-exporting every symbol, so no importer changes. The behavior is byte-for-byte the
// pre-split code, moved verbatim. The concern-modules:
//   - coordinationState         — the lost-wakeup-safe latch/waiter model (refKey/parseRef/
//                                 isSatisfied/isReady/stalledWaiters/registerWaiter/satisfy/fail)
//   - coordinationLog           — event ingestion (parseCoordLine/applyCoordEvent/ingestCoordLog)
//   - coordinationWakes         — wake prompts + inbox view + auto-wake recency gate
//   - coordinationPredicates    — the polled `predicate:` third satisfy path
//   - coordinationNotifications — mobile-push escalation
//   - coordinationDeadlock      — producer resolvers + Tarjan wait-for cycle detection
//   - coordinationJury          — the verification jury (#394) triage/aggregate/plan
//
// Types were already split out into ./coordination.types.ts (#1633).

// Re-export the coordination types (split into ./coordination.types.ts, #1633) so the
// public import surface `@/shared/lib/fleet/coordination` is unchanged for every importer.
export type * from "./coordination.types";

export * from "./coordinationState";
export * from "./coordinationLog";
export * from "./coordinationWakes";
export * from "./coordinationPredicates";
export * from "./coordinationNotifications";
export * from "./coordinationDeadlock";
export * from "./coordinationJury";
