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
  /** Panes STOPPED at a permission prompt / input wait (#4005) — Claude Code's `Notification` hook,
   *  recorded as `bsc-activity attn` and read back from `bsc logs pane-activity`. Keyed by pane id.
   *  Nothing else in the app could see this state: such a pane is not `run` and has no `bsc-wait`, so
   *  it fell through to plain `idle` and looked identical to a session that had simply finished. */
  attention?: ReadonlySet<string>;
  /** Epoch now — injected (impure in render). */
  now: number;
  /** Stall threshold; a wait beyond it escalates to `warning`. Defaults to {@link STALL_WARN_MS}. */
  warnMs?: number;
  /** QUARANTINED panes (#3916) — the warden hard-paused these: it killed the PTY and marked why. Keyed
   *  by pane id, valued by the summary the warden recorded. Until now quarantine was invisible in Glance
   *  (grep found no handling outside `resumeProject`'s comments), so a hard-paused worker read as a plain
   *  `off` node — indistinguishable from one that was simply never launched. */
  quarantined?: Record<string, { summary?: string }>;
  /** HELD streams (#3931) — the dependency gate refused to start these because an upstream has not
   *  landed. Keyed by STREAM id (not pane id: there is no pane, that is the point). Same argument as
   *  quarantine: a held stream has no session, so it fell through to a plain `off` node and was
   *  indistinguishable from one that was never planned — the user could not tell "waiting its turn"
   *  from "broken". A `deadlocked` stream is an ERROR (it can never start on its own); an ordinary
   *  held one stays `off` but now carries the reason that explains itself. */
  held?: Record<string, { reason: string; deadlocked: boolean }>;
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
    // QUARANTINE FIRST (#3916): the warden kills the PTY when it quarantines, so a quarantined pane is
    // never in `livePaneIds` and would otherwise fall through to `off` — reading as "never launched"
    // rather than "hard-paused, here is why". It must outrank every other state: this is the one the
    // user has to act on, and Resume deliberately refuses to relaunch it.
    const q = sig.quarantined?.[paneId];
    if (q) {
      return {
        ...n,
        health: "error" as GHealth,
        activity: "idle" as GActivity,
        reason: q.summary?.trim() || "quarantined by the warden",
      };
    }
    // HELD BY THE DEPENDENCY GATE (#3931) — checked before the plain `off` fall-through for exactly the
    // reason quarantine is: a held stream has no pane, so it would render as an anonymous dark node and
    // the user would have no way to tell "waiting on its upstream" from "never planned". A DEADLOCK is
    // an error the user must fix (the plan's `dependsOn` has a cycle, so it can never start on its own);
    // an ordinary hold is not a fault, so it keeps `off` health and just explains itself.
    const h = sig.held?.[n.id];
    if (h && !sig.livePaneIds.has(paneId)) {
      return {
        ...n,
        health: (h.deadlocked ? "error" : "off") as GHealth,
        activity: "waiting" as GActivity,
        reason: h.reason,
      };
    }
    // NOT LAUNCHED — there is no session behind this node. That is `off`, not `idle`: the two states
    // were indistinguishable while both rendered idle, so a node with no session read as one that was
    // merely quiet, and its empty log view looked like a broken log rather than an absent session.
    // `off` = no session exists · `idle` = a session exists but is not working · `healthy` = working.
    if (!sig.livePaneIds.has(paneId)) return { ...n, health: "off" as GHealth, activity: "idle" as GActivity };
    // BLOCKED ON A PERSON (#4005) — a `bsc-wait` park, or a session stopped at a permission prompt.
    //
    // A wait used to read `healthy` (green, calm) for ten minutes and only then flip to `warning`.
    // Both readings were wrong in the same way: green says "nothing to do" about a session that is
    // waiting on YOU, and orange says "something is degrading" about a normal hand-off. It is neither
    // — it is a request, so it gets its own health. The elapsed-time note is kept, because how long it
    // has been waiting is still worth knowing; it is just no longer the thing that makes it visible.
    const wait = waitByPane.get(paneId);
    if (wait) {
      const elapsed = sig.now - wait.at;
      const note = wait.reason?.trim() || "no instructions";
      const minutes = Math.max(1, Math.floor(elapsed / 60_000));
      const reason = elapsed >= warnMs ? `${note} · ${minutes}m` : note;
      return { ...n, health: "attention" as GHealth, activity: "waiting" as GActivity, reason };
    }
    if (sig.attention?.has(paneId)) {
      return {
        ...n,
        health: "attention" as GHealth,
        activity: "waiting" as GActivity,
        reason: "stopped for you — permission prompt or awaiting input",
      };
    }
    if (sig.paneStatus[paneId] === "run") return { ...n, health: "healthy" as GHealth, activity: "building" as GActivity };
    // Launched, but not working: the session EXISTS and is quiet ⇒ `idle` on both axes. It used to read
    // `healthy` here ("subtly live"), which collided with a genuinely working session — and left `idle`
    // free to be misread as the no-session state. Health now tracks existence + work, not mere launch.
    return { ...n, health: "idle" as GHealth, activity: "idle" as GActivity };
  });
}
