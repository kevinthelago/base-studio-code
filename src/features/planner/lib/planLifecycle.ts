// Lifecycle-aware planning (#458): project lifecycle state derivation. Pure (no
// React / Tauri) so everything is unit-testable without a live app or GitHub.

// ── Lifecycle state ───────────────────────────────────────────────────────────

export type LifecycleState = "new" | "active" | "near-complete";

/** Signals used to derive the lifecycle state. */
export interface LifecycleSignals {
  /** Whether the project is published (activeProjectId is set). */
  isExisting: boolean;
  /** Total plan issues (from phaseStructure rollup). */
  totalIssues: number;
  /** Issues marked closed on GitHub (from ghProgress / phaseStructure). */
  closedIssues: number;
}

// A project is "near-complete" when ≥75% of its issues are closed — a conservative
// threshold to avoid false positives on small plans.
const NEAR_COMPLETE_RATIO = 0.75;

/**
 * Derive a project's lifecycle state from its current signals.
 * "new" → not yet published; "active" → in flight; "near-complete" → most
 * work closed, a refactor pass is appropriate.
 */
export function deriveLifecycleState(s: LifecycleSignals): LifecycleState {
  if (!s.isExisting) return "new";
  const ratio = s.totalIssues > 0 ? s.closedIssues / s.totalIssues : 0;
  return ratio >= NEAR_COMPLETE_RATIO ? "near-complete" : "active";
}

export const LIFECYCLE_LABEL: Record<LifecycleState, string> = {
  "new":           "drafting",
  "active":        "expanding",
  "near-complete": "near-complete",
};
