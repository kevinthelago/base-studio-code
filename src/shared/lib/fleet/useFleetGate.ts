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

// The pump's own imports (the coord read, the landed-evidence probes, the partition) went with its body
// when it was disabled — see `useFleetGate` below. The PURE core above keeps only what it needs, so the
// helpers and their tests survive for whoever re-enables this.
import type { GateStream } from "./streamGate";

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
/**
 * DISABLED (#fleet-gate-stops-launching-on-its-own). Mounted, and does nothing.
 *
 * WHAT IT USED TO DO. Mounted once from the `consolepage` record, it re-evaluated each project's
 * dependency gate on every coord-log change and called `launch` — `resumeProjectFleet` — for any
 * project with a newly-released stream.
 *
 * WHY IT IS OFF. `useLogStream` READS ON MOUNT, and `lastFired` is a fresh ref each app run, so the
 * first evaluation could not be deduped against anything and always fired. Starting the app therefore
 * relaunched whole fleets: measured in the process table seconds after boot as
 * `claude --model sonnet --continue "You are the OPNsense adapter worker…"` — a fleetStartProject
 * kickoff, not a reconnect — with matching bursts of 6 and 13 panes in activity.log. Both of this
 * machine's projects arm it (37 of 38 and 27 of 40 streams carry `dependsOn`), and `planFleet` +
 * `fleetPaneStreams` are persisted, so the gate is loaded and ready the moment the app opens.
 *
 * The header above used to claim "the only action it can take is to launch a stream that was never
 * started". Its actuator relaunches the WHOLE fleet, and for any pane whose PTY did not survive the
 * app close that is a genuine cold start.
 *
 * NOTHING IS STRANDED. A user-initiated Resume still partitions by the SAME dependency gate
 * (`resumeProjectFleet` → `streamGate`), so a held stream is released the moment the user asks for
 * the fleet — it just is not released for them while they are not looking.
 *
 * Disabled rather than deleted, and the signature is kept, so the `consolepage` record's call site
 * (`useFleetGate(fleetGateLaunch)`) needs no edit and re-enabling is restoring one body. If it ever
 * comes back it must NOT act on the mount read — a gate release is an EVENT, and replaying it at boot
 * is the same defect the coordinator's freshness window had.
 *
 * @param _launch the actuator, retained for the signature; never called.
 */
export function useFleetGate(_launch: GateLauncher): void {
  // Intentionally empty: no subscription, no evaluation, no launch.
}
