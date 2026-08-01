// useFleetHeld (#3931 slice 4) — which of a drilled project's streams the dependency gate is holding,
// so the Glance node can SAY SO instead of rendering as an anonymous dark node.
//
// Same probe the resume runs (`fleet_landed_streams` + the coord `maintaining` list + plan.db issues),
// evaluated read-only: this hook never launches anything. It is scoped to the DRILLED project and
// re-runs on coord-log changes, so a stream that gets released stops being marked held without a poll.

import { useState } from "react";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import { bscJson } from "@/shared/lib/core/bsc";
import { useLogStream } from "@/shared/hooks/useLogStream";
import { readCoordState } from "@/shared/lib/fleet/useCoordLog";
import { doneIssueRefs } from "@/shared/lib/fleet/streamCompletion";
import { resolveClosedRefs } from "./fleetIssueState";
import { partitionByDeps, heldReason, sessionDoneStreams, type GateStream, type LandedEvidence } from "@/shared/lib/fleet/streamGate";
import type { PlanIssue } from "@/features/planner/issues/planIssues";

/** Stream id → why it is held. Empty when nothing is gated (the common case once a fleet is flowing). */
export type HeldMap = Record<string, { reason: string; deadlocked: boolean }>;

/**
 * Held streams for `projectKey`. Returns an empty map when there is no project, no fleet, or no stream
 * declares a `dependsOn` — the last check is what keeps this off the git probe entirely for the many
 * fleets that have no dependency graph at all.
 */
export function useFleetHeld(projectKey: string | null, streams: readonly GateStream[] | undefined): HeldMap {
  const [held, setHeld] = useState<HeldMap>({});
  const hasDeps = !!streams?.some((s) => (s.dependsOn ?? []).length > 0);

  useLogStream("coord", async (isCancelled) => {
    if (!projectKey || !streams || !hasDeps) { setHeld({}); return; }
    const [merged, dbIssues, coord, closedRefs] = await Promise.all([
      safeInvoke<string[]>("fleet_landed_streams", { projectKey }, []),
      bscJson<PlanIssue[]>(projectKey, ["plan", "list", "--full", "--json"], []),
      readCoordState(),
      // #4103: plan.db's issue rows are empty for a hand-assembled fleet, so the done-set was empty and
      // the gate held streams whose upstreams had actually landed. GitHub is the other evidence source.
      resolveClosedRefs(streams),
    ]);
    if (isCancelled()) return;
    const evidence: LandedEvidence = {
      doneIssues: new Set([...doneIssueRefs(dbIssues ?? []), ...closedRefs]),
      mergedBranches: new Set(merged ?? []),
      // A failed coord read contributes no session evidence rather than fabricating it — the same rule
      // the resume and the pump follow. Over-reporting held is safe here (it is display only); claiming
      // a stream landed when the log could not be read is not.
      sessionDone: sessionDoneStreams(coord?.state.maintaining ?? [], projectKey),
    };
    const { held: h } = partitionByDeps(streams, evidence);
    setHeld(Object.fromEntries(h.map((x) => [x.streamId, { reason: heldReason(x), deadlocked: x.deadlocked }])));
  }, [projectKey, hasDeps, streams?.length]);

  return held;
}
