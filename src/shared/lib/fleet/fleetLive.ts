// Live Fleet data (#412) — PURE mappers from the running app state to the Fleet
// board shapes. The roster comes from the store's launched fleet
// (`fleetPaneStreams`), run/idle from the live `paneStatus` map (#412), and
// blocked/asking/waiting from the coordination log (CoordState). No fabrication —
// GitHub-derived analytics (throughput, merge queue, time-to-land) and token/cost
// accounting are deferred to follow-ups and rendered as explicit "not wired" states.
//
// Framework-free + unit-tested; the store/coord wiring lives in hooks/useFleetLive.

import type { CoordState } from "./coordination";
import type { AgentStream } from "@/features/planner/fleet/planFleet";
import type { WorkerStatus } from "@/shared/data/fleet";

/** Minimal AgentProfile fields we need for labels/colors (avoids a hard dep). */
export interface ProfileLike { id: string; name: string }

export interface LiveWorker {
  /** pane id, e.g. "t2p0" — the coordination `session` key too. */
  id: string;
  /** display name (the stream name). */
  name: string;
  /** stream/worktree repo. */
  repo: string;
  /** resolved profile label + a stable color. */
  profileLabel: string;
  profileColor: string;
  status: WorkerStatus;
  /** the work item it's on (first owned issue, else the stream name). */
  issue: string;
  /** a short sub-note: the block dep / question / wait reason, when parked. */
  note: string;
  /** count of issues this stream owns. */
  ownedTotal: number;
}

/** Stable color from a string (profile id), matching the loginColor convention. */
function hashColor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `oklch(0.72 0.13 ${h % 360})`;
}

/** Parse the tab index out of a pane id ("t{tab}p{pane}"), or -1. */
export function tabOfPane(paneId: string): number {
  const m = /^t(\d+)p\d+$/.exec(paneId);
  return m ? Number(m[1]) : -1;
}

/**
 * The live status for a worker pane: coordination wins (a parked worker is
 * asking / waiting / blocked), otherwise the raw run/idle from `paneStatus`
 * ("run" → running, anything else → idle).
 */
export function statusForPane(
  paneId: string, coord: CoordState, paneStatus: Record<string, "run" | "on" | "idle">,
): WorkerStatus {
  if (coord.asking.some(a => a.session === paneId)) return "asking";
  if (coord.waiting.some(w => w.session === paneId)) return "waiting";
  if (coord.waiters.some(w => w.session === paneId)) return "blocked";
  return paneStatus[paneId] === "run" ? "running" : "idle";
}

/** The parked-state note for a pane (question / wait reason / block deps), or "". */
function noteForPane(paneId: string, coord: CoordState): string {
  const ask = coord.asking.find(a => a.session === paneId);
  if (ask) return ask.question;
  const wait = coord.waiting.find(w => w.session === paneId);
  if (wait) return wait.reason;
  const blocked = coord.waiters.find(w => w.session === paneId);
  if (blocked) {
    const deps = blocked.deps.map(d => (d.kind === "issue" ? `#${d.number}` : d.kind === "contract" ? `contract:${d.name}` : d.kind)).join(", ");
    return deps ? `blocked on ${deps}` : "blocked";
  }
  return "";
}

export interface BuildWorkersInput {
  /** the launched fleet: pane id → its stream. */
  fleetPaneStreams: Record<string, AgentStream>;
  paneStatus: Record<string, "run" | "on" | "idle">;
  coord: CoordState;
  /** tab count, so panes on closed tabs are dropped. */
  tabCount: number;
  disabledPanes: Record<string, boolean>;
  profiles: ProfileLike[];
}

/** Build the live worker roster from the running fleet. Only panes whose tab is
 *  still open and not disabled are included (a launched-then-closed fleet drops). */
export function buildLiveWorkers(input: BuildWorkersInput): LiveWorker[] {
  const { fleetPaneStreams, paneStatus, coord, tabCount, disabledPanes, profiles } = input;
  const profById = new Map(profiles.map(p => [p.id, p]));
  const workers: LiveWorker[] = [];
  for (const [paneId, stream] of Object.entries(fleetPaneStreams)) {
    const tab = tabOfPane(paneId);
    if (tab < 0 || tab >= tabCount || disabledPanes[paneId]) continue;
    const prof = stream.profile ? profById.get(stream.profile) : undefined;
    workers.push({
      id: paneId,
      name: stream.name,
      repo: stream.repo,
      profileLabel: prof?.name ?? stream.profile ?? "—",
      profileColor: stream.profile ? hashColor(stream.profile) : "var(--fg-dim)",
      status: statusForPane(paneId, coord, paneStatus),
      issue: stream.issues[0] ?? stream.name,
      note: noteForPane(paneId, coord),
      ownedTotal: stream.issues.length,
    });
  }
  // Stable order: by tab/pane id.
  return workers.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/** Worker counts per status (drives the donut). */
export function statusCounts(workers: LiveWorker[]): Partial<Record<WorkerStatus, number>> {
  const c: Partial<Record<WorkerStatus, number>> = {};
  for (const w of workers) c[w.status] = (c[w.status] ?? 0) + 1;
  return c;
}

export interface FleetKpis {
  total: number;
  active: number;       // running
  needAttention: number; // blocked | asking | waiting
  idle: number;
}
export function deriveFleetKpis(workers: LiveWorker[]): FleetKpis {
  const is = (s: WorkerStatus) => workers.filter(w => w.status === s).length;
  return {
    total: workers.length,
    active: is("running"),
    needAttention: is("blocked") + is("asking") + is("waiting"),
    idle: is("idle"),
  };
}
