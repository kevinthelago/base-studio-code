// Director drive mode (#366) -- how the project's async-integrator "director" session is
// driven once the fleet is running. The director is a plain Claude session that, after its
// kickoff, idles forever; this config + the runtime pump (useDirectorPump) decide when to
// re-prompt it so it actually reviews/merges worker PRs and resolves coordination events.
// Pure + unit-tested; mirrors agentFlow.ts (the per-stream flow config pattern).


/**
 * - `event`     -- re-prompt the director whenever workers post new coordination events
 *                  (landed / blocked / waiting / failed), but only while it is idle.
 * - `heartbeat` -- re-prompt on a fixed interval (a periodic fleet sweep), idle-gated.
 * - `manual`    -- never auto-prompt; the user pokes it from the Coordination inbox.
 * - `off`       -- the director is never driven (a static session).
 */
export type DirectorDrive = "event" | "heartbeat" | "manual" | "off";

export const DIRECTOR_DRIVES: DirectorDrive[] = ["event", "heartbeat", "manual", "off"];
export const DEFAULT_DIRECTOR_DRIVE: DirectorDrive = "event";

/** Default heartbeat cadence and the post-inject cooldown (guards the inject-then-run race). */
export const DEFAULT_HEARTBEAT_MS = 10 * 60 * 1000;
export const INJECT_COOLDOWN_MS = 6000;

/** How often an IDLE director is re-told about outstanding questions (#4019).
 *
 *  Shorter than {@link DEFAULT_HEARTBEAT_MS} on purpose: a worker is PARKED for every second of
 *  this, so ten minutes of silence is ten minutes of a stalled agent. Long enough that a director
 *  working through a batch is not interrupted mid-thought each time it draws breath. */
export const ASK_REMINDER_MS = 3 * 60 * 1000;

/** Coerce a raw fleet.json value into a known drive mode (default when unrecognized). */
export function normalizeDirectorDrive(raw: unknown): DirectorDrive {
  if (typeof raw !== "string") return DEFAULT_DIRECTOR_DRIVE;
  const v = raw.trim().toLowerCase();
  // Accept the longer alias the planner prose uses for the event mode.
  if (v === "event-driven") return "event";
  return (DIRECTOR_DRIVES as string[]).includes(v) ? (v as DirectorDrive) : DEFAULT_DIRECTOR_DRIVE;
}

/** Apply the default when the drive is unset. */
export function resolveDirectorDrive(drive: DirectorDrive | undefined): DirectorDrive {
  return drive ?? DEFAULT_DIRECTOR_DRIVE;
}

/** Stable key for a pending ask (session + when), so the pump surfaces each ask once. */
export function askKey(a: { session: string; at: number }): string {
  return `${a.session}@${a.at}`;
}

// The brief surfacing MOVED to `shared/lib/fleet/briefRouting.ts` (#brief-routes-to-its-target).
// `briefKey`/`pendingBriefPrompt` lived here and keyed only `<from>@<at>`, with no notion of the
// target — which is why every brief was delivered to every director pane. Routing needs the whole
// pane set, not just the director's, so it does not belong in the director's own drive module.

/** Stable key for an open project request, so the pump surfaces each one once. Keyed on the plan.db
 *  ROW ID, not session+time: the id is the thing the director resolves by, and it is what
 *  `request-resolved` carries, so the key prunes exactly when the request is answered. */
export function requestKey(r: { id: string }): string {
  return `req:${r.id}`;
}

/**
 * Should an idle director be re-told about outstanding work (#4019)?
 *
 * The pump delivers each ask/request exactly ONCE (its `surfaced` guard), which is right for not
 * re-queueing every tick — but it makes a single missed delivery final. If the director was mid-turn,
 * or simply did not act, nothing ever says it again and the worker waits forever. Measured: 44 asks
 * against 20 answers.
 *
 * This is the backstop, and it is deliberately NOT wired into that guard: the immediate delivery stays
 * exactly as it was. Gated on `idle` because the whole point is to spend the moment the director has
 * nothing else to do, and rate-limited so a director that keeps ignoring it is nagged at a sane
 * interval rather than on every tick.
 */
export function shouldRemind(inp: { idle: boolean; pending: number; now: number; lastRemindAt: number; everyMs: number }): boolean {
  if (!inp.idle || inp.pending === 0) return false;
  return inp.lastRemindAt === 0 || inp.now - inp.lastRemindAt >= inp.everyMs;
}
