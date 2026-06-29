// Agents — Flow-tab derivation + status colors (#199 / #220 / #1643).
//
// The fleet's live work-flow on the Agents screen: which sessions are parked on a
// dependency and which work items are flowing through their workflow stages. Pure
// summary + color helpers, split out of AgentsWorkspace so they're React-free + testable.

import type { BlockedView, Waiter } from "@/shared/lib/fleet/coordination";
import type { WorkflowRun } from "@/shared/lib/fleet/conductor";

export interface FlowSummary {
  /** Blocked sessions flagged as stalled. */
  stalled: number;
  /** Blocked sessions sitting in a wait-for cycle. */
  deadlocked: number;
  /** `Object.entries(runs)` — workflow runs as [id, run] pairs. */
  runEntries: [string, WorkflowRun][];
  /** Nothing ready, blocked, or flowing — show the idle hint. */
  idle: boolean;
}

/** Summarize the Flow tab's coordination + workflow state. */
export function flowSummary(
  views: BlockedView[],
  ready: Waiter[],
  runs: Record<string, WorkflowRun>,
): FlowSummary {
  const stalled = views.filter((v) => v.stalled).length;
  const deadlocked = views.filter((v) => v.deadlocked).length;
  const runEntries = Object.entries(runs);
  const idle = ready.length === 0 && views.length === 0 && runEntries.length === 0;
  return { stalled, deadlocked, runEntries, idle };
}

/** Color for a dependency's satisfaction status. */
export function depColor(status: BlockedView["deps"][number]["status"]): string {
  return status === "satisfied" ? "var(--success)" : status === "failed" ? "var(--danger)" : "var(--fg-dim)";
}

/** Color for a workflow run's overall status. */
export function stageColor(status: string): string {
  return status === "done" ? "var(--success)" : status === "escalated" ? "var(--danger)" : "var(--accent)";
}
