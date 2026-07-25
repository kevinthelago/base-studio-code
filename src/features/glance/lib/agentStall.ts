// Agent-health watchdog (#2541) — the piece that GENERATES the Glance "warning" from live agent state,
// not from a crash. A `bsc-wait` (an EXPECTED pause for the user) is calm while it's fresh — the project
// reads activity "waiting". But once a wait OVERSTAYS its welcome (no instructions for N minutes), it's a
// stall the user should be pulled to: it escalates the project to health "warning" (orange dot) with a
// duration reason ("<note> · Nm"), which the existing dot+reason pipeline renders for free.
//
// Deliberately NOT routed through errordb / the fault-triage fix loop (#2265): a "no instructions" stall
// needs the USER to act, not a fix dispatched to the director. It's an ephemeral, derived health overlay
// (like liveness, #2263) — it clears the instant the agent resumes. Pure; `now` is injected for testing.
import type { ProjectLite } from "./glanceData";
import type { GHealth, GActivity, GRawNode } from "./glanceGraph";
import { fleetPaneId } from "@/app/console/lib/paneIdentity";

/** A `bsc-wait` parked longer than this escalates from the calm "waiting" activity to an orange
 *  "warning" health. 10 min — long enough that a normal think/confirm pause stays calm. Overridable per
 *  call so a Settings field can drive it later (#2541 follow-up). */
export const STALL_WARN_MS = 10 * 60_000;

/** The minimal waiting-session shape the watchdog reads — a projection of `CoordState.waiting`. */
export interface WaitLite { session: string; reason: string; at: number }

/** The project (plan) key that owns a session/pane id — everything before the first ':' (pane ids are
 *  `<key>:<stream>` / `<key>:director` / `<key>:<repo>:triage`, all prefixed by the plan key, #2409). */
export function projectKeyOfSession(session: string): string {
  const i = session.indexOf(":");
  return i < 0 ? session : session.slice(0, i);
}

/**
 * Keep only the waits whose session still EXISTS (#3429) — the liveness guard the L0 watchdog was missing.
 *
 * `CoordState.waiting` is a replay of the coord log: an entry is cleared only by a LATER event from that
 * same session, and killing a pane emits none. So a wait parked by a long-dead agent stayed outstanding
 * forever while `now - w.at` only grew, pinning its project orange permanently — a `warning` that no longer
 * described anything. A session that no longer exists cannot be waiting on the user.
 *
 * `livePaneIds` is the same pruned set the L1 overlay reads (tab membership minus ended/disabled panes), so
 * both layers decide "does this session exist?" from one signal. Pure.
 */
export function liveWaits(waiting: WaitLite[], livePaneIds: ReadonlySet<string>): WaitLite[] {
  return waiting.filter((w) => livePaneIds.has(w.session));
}

const worse = (a: GHealth, b: GHealth): boolean => a === "error" && b !== "error";

/**
 * Escalate PARKED agents onto the Glance node axes (#2541 watchdog). Per project the OLDEST outstanding
 * `bsc-wait` decides: while it's under `warnMs` the project reads a calm activity "waiting"; once it
 * exceeds `warnMs` it escalates to health "warning" with a "<note> · Nm" reason. Only ever ESCALATES
 * health (never downgrades an already-worse state). Pure.
 *
 * Apply BEFORE the errordb fault overlay (`applyFaultHealth`) so a real error still beats a stall.
 */
export function applyStallHealth(projects: ProjectLite[], waiting: WaitLite[], now: number, warnMs = STALL_WARN_MS): ProjectLite[] {
  if (waiting.length === 0) return projects;
  const oldest = new Map<string, WaitLite>();
  for (const w of waiting) {
    const key = projectKeyOfSession(w.session);
    const prev = oldest.get(key);
    if (!prev || w.at < prev.at) oldest.set(key, w);
  }
  return projects.map((p) => {
    const w = oldest.get(p.id);
    if (!w) return p;
    const elapsed = now - w.at;
    if (elapsed < warnMs) return { ...p, activity: "waiting" }; // fresh, expected pause — stays calm
    const minutes = Math.max(1, Math.floor(elapsed / 60_000));
    const note = w.reason?.trim() || "no instructions";
    const health: GHealth = worse(p.health ?? "idle", "warning") ? (p.health as GHealth) : "warning";
    return { ...p, activity: "waiting", health, reason: `${note} · ${minutes}m` };
  });
}

/** The live signals a fleet-drill (L1) node reads to lift off its planned rest state (#3252). All keyed by
 *  the node's PANE id (`fleetPaneId` → `<project>:<stream>` / `<project>:director`). */
export interface FleetLiveSignals {
  /** Launched-tab membership — the session cell exists + is openable (`livePaneIds`). */
  livePaneIds: ReadonlySet<string>;
  /** Per-pane run status — `"run"` while the session is actively working (the console's aggregate state). */
  paneStatus: Record<string, string>;
  /** Parked `bsc-wait` sessions (from `CoordState.waiting`). */
  waiting: WaitLite[];
  /** Epoch now — injected (impure in render). */
  now: number;
  /** Stall threshold; a wait beyond it escalates to `warning`. Defaults to {@link STALL_WARN_MS}. */
  warnMs?: number;
}

/**
 * Overlay the LIVE session state onto a project's fleet-drill (L1) agent nodes (#3252, the #2541 axes) —
 * the agent twin of the L0 {@link applyStallHealth}. Each node is keyed by its pane id
 * `fleetPaneId(projectKey, node.id)`, and its OWN health/activity is set from what its session is doing NOW:
 *
 *   - not launched (NO session exists)           → off · idle
 *   - launched + running (`paneStatus === "run"`) → healthy · building
 *   - launched + parked on a fresh `bsc-wait`    → healthy · waiting
 *   - that wait overstayed `warnMs`              → warning · waiting (reason "<note> · Nm")
 *   - launched but quiet (between prompts)       → idle · idle  (it EXISTS but is not working)
 *
 * The `preview` node (not an agent) is left untouched. The director gets the same treatment via
 * `<project>:director`, so it finally moves off idle. Pure — apply to `rawNodes` BEFORE `buildGraph` so the
 * dependency rollup + inherited-health recompute over the live values.
 */
export function applyFleetLiveStatus(nodes: GRawNode[], projectKey: string, sig: FleetLiveSignals): GRawNode[] {
  const warnMs = sig.warnMs ?? STALL_WARN_MS;
  const waitByPane = new Map(sig.waiting.map((w) => [w.session, w] as const));
  return nodes.map((n) => {
    if (n.preview) return n; // not an agent — its own healthy/live state stands
    const paneId = fleetPaneId(projectKey, n.id);
    // NOT LAUNCHED — there is no session behind this node. That is `off`, not `idle`: the two states
    // were indistinguishable while both rendered idle, so a node with no session read as one that was
    // merely quiet, and its empty log view looked like a broken log rather than an absent session.
    // `off` = no session exists · `idle` = a session exists but is not working · `healthy` = working.
    if (!sig.livePaneIds.has(paneId)) return { ...n, health: "off" as GHealth, activity: "idle" as GActivity };
    const wait = waitByPane.get(paneId);
    if (wait) {
      const elapsed = sig.now - wait.at;
      if (elapsed >= warnMs) {
        const minutes = Math.max(1, Math.floor(elapsed / 60_000));
        const note = wait.reason?.trim() || "no instructions";
        return { ...n, health: "warning" as GHealth, activity: "waiting" as GActivity, reason: `${note} · ${minutes}m` };
      }
      return { ...n, health: "healthy" as GHealth, activity: "waiting" as GActivity }; // fresh pause — calm
    }
    if (sig.paneStatus[paneId] === "run") return { ...n, health: "healthy" as GHealth, activity: "building" as GActivity };
    // Launched, but not working: the session EXISTS and is quiet ⇒ `idle` on both axes. It used to read
    // `healthy` here ("subtly live"), which collided with a genuinely working session — and left `idle`
    // free to be misread as the no-session state. Health now tracks existence + work, not mere launch.
    return { ...n, health: "idle" as GHealth, activity: "idle" as GActivity };
  });
}
