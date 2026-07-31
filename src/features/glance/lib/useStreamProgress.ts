// The drilled project's per-stream issue progress (#4050).
//
// ONE read per project on a slow cadence, partitioned in memory — never one read per node. That
// fan-out shape has cost real time in this app before (#3908 / #3912 / #3944 / #3954), and a graph of
// twenty workers would make twenty spawns of the same query.
//
// Scoped to the DRILLED project because that is the only fleet whose nodes are on screen: the cost is
// bounded by what the user is actually looking at, and it stops entirely when they leave the drill.
//
// It cannot piggyback on `useWorkerAutoEnd`'s read of the same data — that one is event-gated on panes
// that just went idle, so it says nothing while a fleet is steadily working, which is exactly when a
// progress bar is worth having.
import { useEffect, useState } from "react";
import { bscJson } from "@/shared/lib/core/bsc";
import { usePoll } from "@/shared/hooks/usePoll";
import type { OwnedIssue } from "@/shared/lib/fleet/workerEnd";
import { streamProgress, planDbDoneRefs, type StreamProgress } from "./streamProgress";

/** Issue counts move at human speed — a worker closing one is a minutes-scale event, so a fast poll
 *  would spend spawns to re-read an unchanged answer. */
export const PROGRESS_POLL_MS = 20_000;

/** What one poll of plan.db yields. #4102 added `doneRefs`: the same read now also feeds the
 *  ref-based progress path, which needs to know WHICH issues are finished rather than just how many —
 *  so plan.db statuses and the GitHub overlay can be unioned into one done-set. One read, two shapes;
 *  a second hook over the same query would be the fan-out this file's header warns about. */
export interface PlanDbProgress {
  byStream: Map<string, StreamProgress>;
  /** Refs of issues plan.db considers finished (`complete` | `verified`). */
  doneRefs: Set<string>;
}

const EMPTY: PlanDbProgress = { byStream: new Map(), doneRefs: new Set() };

/** Per-stream `done / total` for `projectKey` plus its done refs, or empty when not drilled / no plan
 *  store. */
export function useStreamProgress(projectKey: string | null): PlanDbProgress {
  const [state, setState] = useState<PlanDbProgress>(EMPTY);

  // Clear on a project switch so the previous fleet's numbers never render against this one's nodes.
  useEffect(() => { setState(EMPTY); }, [projectKey]);

  usePoll(async (isCancelled) => {
    if (!projectKey) return;
    const issues = await bscJson<OwnedIssue[] | null>(projectKey, ["plan", "list", "--full", "--json"], null);
    if (isCancelled() || !issues) return;   // read failed / no plan.db ⇒ keep the last good answer
    setState({ byStream: streamProgress(issues), doneRefs: planDbDoneRefs(issues) });
  }, PROGRESS_POLL_MS, [projectKey]);

  return state;
}
