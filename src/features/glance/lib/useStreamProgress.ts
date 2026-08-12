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
import { streamProgress, planDbDoneRefs, planDbClosedByRef, projectProgress, type StreamProgress } from "./streamProgress";
import { knownRefAliases } from "./fleetPlanProgress";

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
  /** Per-ref closed-ness — `true` finished, `false` known-unfinished, ABSENT when plan.db has no such
   *  row. The Plan dock renders per-issue state from this, so a project that never uses GitHub still
   *  shows real states instead of "state unknown" on every row. */
  closedByRef: Map<string, boolean>;
  /** Every ref plan.db can be asked about, in each spelling it answers to (`knownRefAliases`).
   *
   *  `glance-progress-ref-namespace-split`: a fleet stream's `issues` are a SEPARATE ownership record
   *  and may be written in another namespace entirely — on `studio-code` they are bare GitHub numbers
   *  while plan.db is all slugs, so nothing matched and every owning node showed `0/N`. This is what
   *  lets the ref path tell "owned and unfinished" apart from "owned and unknowable", and stand aside
   *  for plan.db in the second case. */
  knownRefs: Set<string>;
  /** The project's progress across EVERY issue, stream-owned or not — the same `complete | verified`
   *  over the same rows that `bsc project progress` counts for the L0 project node.
   *
   *  `glance-progress-ref-namespace-split`: L0 and L1 disagreed (24 vs 56 on `studio-code`) because they
   *  counted different ownership records and neither said so. This gives the DIRECTOR — the one node
   *  accountable for the whole board rather than a lane — the same number L0 shows, from the same read,
   *  so the two levels agree by construction instead of by coincidence. */
  overall: StreamProgress;
}

const EMPTY: PlanDbProgress = {
  byStream: new Map(), doneRefs: new Set(), closedByRef: new Map(), knownRefs: new Set(),
  overall: { done: 0, total: 0 },
};

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
    setState({
      byStream: streamProgress(issues),
      doneRefs: planDbDoneRefs(issues),
      closedByRef: planDbClosedByRef(issues),
      knownRefs: knownRefAliases(issues),
      overall: projectProgress(issues),
    });
  }, PROGRESS_POLL_MS, [projectKey]);

  return state;
}
