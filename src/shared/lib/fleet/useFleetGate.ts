// The launch pump (#3931 slice 3) — start a HELD stream once its upstreams land.
//
// The gate (streamGate.ts) decides at resume time which streams may start; without a pump the held ones
// would stay held until the user pressed Resume again. This closes the loop: when the evidence changes,
// re-evaluate and launch whatever just became ready.
//
// It is EVENT-DRIVEN on the coordination log, not polled. A worker finishing emits `bsc-maintain`
// (#1957) and the director's merge/close emits its own line, so every transition that can release a
// downstream stream writes to that log first — which `useLogStream("coord", …)` already surfaces for
// free. That matters: the alternative (polling `fleet_landed_streams`) is a git subprocess per repo per
// tick, and this app is already spawn-bound (#3871). The pump therefore costs ONE extra git probe per
// coord-log CHANGE, and nothing at all while the fleet is quiet.
//
// It never parks anything and never wakes a running session — the only action it can take is to launch a
// stream that was never started, which is exactly what #1039 left room for.

import { useRef } from "react";
import { useAppStore } from "@/store";
import { useLogStream } from "@/shared/hooks/useLogStream";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import { readCoordState } from "./useCoordLog";
import { doneIssueRefs } from "./streamCompletion";
import { partitionByDeps, sessionDoneStreams, type GateStream, type LandedEvidence } from "./streamGate";
import { bscJson } from "@/shared/lib/core/bsc";
import type { PlanIssue } from "@/features/planner/issues/planIssues";
import { log } from "@/shared/lib/core/log";

/** Launch the streams that just became ready for one project. Injected so the pump is testable. */
export type GateLauncher = (projectKey: string) => Promise<unknown>;

/**
 * Which projects the pump should evaluate: those with a fleet roster in the store. A project with no
 * roster has never launched, so there is nothing to release. Pure.
 */
export function gatedProjects(fleetPaneStreams: Record<string, unknown>): string[] {
  const keys = new Set<string>();
  for (const paneId of Object.keys(fleetPaneStreams)) {
    const key = paneId.split(":")[0];
    if (key) keys.add(key);
  }
  return [...keys];
}

/**
 * Stream ids the pump should launch: every READY stream that isn't quarantined.
 *
 * #3971 — this used to also subtract "live" panes, which broke recovery at exactly the moment it was
 * needed. The liveness signal was tab membership (`in a tab && !ended && !disabled`), so at boot every
 * persisted pane counted as live — including the 25 that had come up as BARE SHELLS (`init=<none>`,
 * `LaunchPlan::None`, no agent). The pump skipped them as already-running and released 3 streams
 * against a fleet with 13 dependency-free roots.
 *
 * That definition is right where it came from — Glance's node colouring and #3954's warden scoping
 * both ask "does a session cell exist?" — and wrong here, where the question is "is an AGENT running?".
 * A bare shell answers no.
 *
 * Rather than teach the pump to detect a bare shell, drop the filter: `resumeProject.ts` settled this
 * in #3923 — "a live pane is safe to include in the relaunch: `pty_create` reconnects to an existing
 * session and returns before spawning, so it never re-sends `claude --continue` to a running agent."
 * The pump's actuator IS `resumeProjectFleet`, so it inherits that guarantee, and the caution I added
 * had already been deliberately removed from that path.
 *
 * Repeat-firing is owned by the caller's `lastFired` fingerprint, which is the honest mechanism for it
 * — not a liveness proxy that is wrong precisely when recovery matters. Quarantine still excludes: a
 * quarantined worker is surfaced, never relaunched (#3916). Pure.
 */
export function newlyLaunchable(
  ready: readonly GateStream[],
  projectKey: string,
  quarantined: Record<string, unknown>,
): string[] {
  return ready.map((s) => s.id).filter((id) => !quarantined[`${projectKey}:${id}`]);
}

/**
 * Mount once (alongside `useCoordinator`, in the always-mounted ConsoleWorkspace). On every coord-log
 * change it re-evaluates each project's dependency gate and calls `launch` for any project that has a
 * stream newly released.
 *
 * `launch` is normally `resumeProjectFleet`, which is the right actuator precisely because it is
 * idempotent: it re-partitions from scratch, reconnects live panes without re-sending anything (the
 * backend's `pty_create` returns early for an existing session), and starts only what the gate allows.
 * So "launch the newly-ready stream" needs no new narrow launch path.
 */
export function useFleetGate(launch: GateLauncher): void {
  // Per-project fingerprint of the last action set, so an unchanged gate doesn't re-launch on every
  // unrelated coord line (an `ask`, a `waiting`, a brief — most log traffic releases nothing).
  const lastFired = useRef<Record<string, string>>({});

  useLogStream("coord", async (isCancelled) => {
    const st = useAppStore.getState();
    const projects = gatedProjects(st.fleetPaneStreams);
    if (projects.length === 0) return;
    const coord = await readCoordState();
    // A failed read withholds evidence rather than fabricating it — the same rule the resume follows.
    // Firing on a null read would launch held streams on a transient log error.
    if (!coord || isCancelled()) return;

    for (const projectKey of projects) {
      const fleet = st.planFleet[projectKey];
      if (!fleet || fleet.streams.length === 0) continue;
      // Only pay for the git probe when this project actually has something waiting.
      const hasDeps = fleet.streams.some((s) => (s.dependsOn ?? []).length > 0);
      if (!hasDeps) continue;

      const [merged, dbIssues] = await Promise.all([
        safeInvoke<string[]>("fleet_landed_streams", { projectKey }, []),
        bscJson<PlanIssue[]>(projectKey, ["plan", "list", "--full", "--json"], []),
      ]);
      if (isCancelled()) return;
      const evidence: LandedEvidence = {
        doneIssues: doneIssueRefs(dbIssues ?? []),
        mergedBranches: new Set(merged ?? []),
        sessionDone: sessionDoneStreams(coord.state.maintaining, projectKey),
      };
      const { ready } = partitionByDeps(fleet.streams, evidence);
      const launchable = newlyLaunchable(ready, projectKey, st.quarantinedPanes);
      const fingerprint = launchable.slice().sort().join(",");
      if (!fingerprint || lastFired.current[projectKey] === fingerprint) continue;
      lastFired.current[projectKey] = fingerprint;
      log.info(`fleet-gate: releasing ${launchable.length} stream(s) for ${projectKey}: ${fingerprint}`);
      await launch(projectKey);
      if (isCancelled()) return;
    }
  });
}
