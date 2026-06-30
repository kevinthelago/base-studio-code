// Progress-gated relaunch (#1004): a triage / fleet re-run reads each issue's status from plan.db and
// must NOT restart a worker whose work is already done. These pure helpers decide, from the current
// issue statuses, which streams have finished and which still have outstanding work to (re)launch.

import type { AgentStream } from "@/features/planner/fleet/planFleet";
import type { PlanIssue } from "@/features/planner/issues/planIssues";

/** Refs of issues a worker has nothing left to do on — `complete` (landed) or `verified` (accepted). */
export function doneIssueRefs(issues: PlanIssue[]): Set<string> {
  return new Set(
    issues.filter((i) => i.status === "complete" || i.status === "verified").map((i) => i.ref),
  );
}

/**
 * A stream is complete when it owns at least one issue and EVERY one is done — so a relaunch puts its
 * worker into maintenance, not back to building (it already finished). A stream that owns no issues is
 * never "complete" (there's no
 * evidence of finished work; let it launch — e.g. a standing / open-ended worker).
 */
export function streamComplete(stream: AgentStream, done: Set<string>): boolean {
  return stream.issues.length > 0 && stream.issues.every((r) => done.has(r));
}

/**
 * Partition a fleet's streams for a progress-gated relaunch: `active` still have outstanding work and
 * (re)launch to keep building; `maintenance` already finished every owned issue and relaunch INTO the
 * maintenance posture (#1957) — they stay alive + ready for the director to dispatch new lane work,
 * rather than being skipped/ended. Order is preserved.
 */
export function pruneCompletedStreams(
  streams: AgentStream[],
  done: Set<string>,
): { active: AgentStream[]; maintenance: AgentStream[] } {
  const active: AgentStream[] = [];
  const maintenance: AgentStream[] = [];
  for (const st of streams) (streamComplete(st, done) ? maintenance : active).push(st);
  return { active, maintenance };
}

/**
 * Of the live worker panes (`fleetPaneStreams`: pane id → its stream), the ones whose stream has
 * finished every owned issue — so the always-on warden must NOT quarantine them: they're in
 * maintenance (#1957), not building, so post-completion activity is expected, not drift. The warden
 * also lifts any existing quarantine on these. `doneFor(paneId)` yields that pane's project's
 * done-issue refs (the warden reads issue statuses from plan.db per project). Pure (no IPC/store).
 */
export function completedWorkerPanes(
  fleetPaneStreams: Record<string, AgentStream>,
  doneFor: (paneId: string) => Set<string> | undefined,
): Set<string> {
  const out = new Set<string>();
  for (const [paneId, stream] of Object.entries(fleetPaneStreams)) {
    const done = doneFor(paneId);
    if (done && streamComplete(stream, done)) out.add(paneId);
  }
  return out;
}
