// Agents — Flow-tab derivation + status colors (#199 / #1643).
//
// The fleet's live work-flow on the Agents screen: which sessions are parked on a
// dependency. Pure summary + color helpers, split out of AgentsWorkspace so they're
// React-free + testable.

import type { BlockedView, Waiter } from "@/shared/lib/fleet/coordination";

export interface FlowSummary {
  /** Blocked sessions flagged as stalled. */
  stalled: number;
  /** Blocked sessions sitting in a wait-for cycle. */
  deadlocked: number;
  /** Nothing ready or blocked — show the idle hint. */
  idle: boolean;
}

/** Summarize the Flow tab's coordination state. */
export function flowSummary(
  views: BlockedView[],
  ready: Waiter[],
): FlowSummary {
  const stalled = views.filter((v) => v.stalled).length;
  const deadlocked = views.filter((v) => v.deadlocked).length;
  const idle = ready.length === 0 && views.length === 0;
  return { stalled, deadlocked, idle };
}

/** Color for a dependency's satisfaction status. */
export function depColor(status: BlockedView["deps"][number]["status"]): string {
  return status === "satisfied" ? "var(--success)" : status === "failed" ? "var(--danger)" : "var(--fg-dim)";
}
