// Progress-gated relaunch (#1004): a triage / fleet re-run reads each issue's status from plan.db and
// must NOT restart a worker whose work is already done. These pure helpers decide, from the current
// issue statuses, which streams have finished and which still have outstanding work to (re)launch.

import type { AgentStream } from "./planFleet";
import type { PlanIssue } from "../issues/planIssues";

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
