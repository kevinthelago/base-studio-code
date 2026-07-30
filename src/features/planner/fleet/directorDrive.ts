// Director drive mode (#366) -- how the project's async-integrator "director" session is
// driven once the fleet is running. The director is a plain Claude session that, after its
// kickoff, idles forever; this config + the runtime pump (useDirectorPump) decide when to
// re-prompt it so it actually reviews/merges worker PRs and resolves coordination events.
// Pure + unit-tested; mirrors agentFlow.ts (the per-stream flow config pattern).
import { parseCoordLine, type CoordEvent, type CoordRef, type AskingSession, type ReceivedBrief, type OpenRequest } from "@/shared/lib/fleet/coordination";

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

/** Short human label for a coordination ref, for the injected prompt. */
function refLabel(ref: CoordRef): string {
  switch (ref.kind) {
    case "issue":     return `#${ref.number}`;
    case "contract":  return `contract:${ref.name}`;
    case "file":      return `file:${ref.path}`;
    case "predicate": return `predicate:${ref.expr}`;
    case "session":   return `session:${ref.id}`;
  }
}

/** The director's standing instruction, appended to every injected prompt so the prompt is
 *  self-contained regardless of what the kickoff said. Single line (no newlines -- the pump
 *  submits it by writing the text + a carriage return to the director's stdin). */
const DIRECTOR_ACTION =
  "Review the open PRs on the build branches and merge the green ones; for each, run " +
  "`bsc-merged <ref>` (then `bsc-closed <ref>` when you close its issue) so any parked " +
  "workers wake. Unblock anyone blocked or waiting, and keep the milestones/board current. " +
  "If nothing needs doing, say so and stop.";

/** Build the event-driven injection summarizing the fresh worker events. Single line. */
export function eventDirectorPrompt(events: CoordEvent[]): string {
  const segs: string[] = [];
  const asks = events.filter((e) => e.type === "ask") as Array<{ session: string; question: string }>;
  const landed = events.filter((e) => e.type === "landed").map((e) => refLabel((e as { ref: CoordRef }).ref));
  const failed = events.filter((e) => e.type === "failed").map((e) => refLabel((e as { ref: CoordRef }).ref));
  const blocked = events.filter((e) => e.type === "blocked") as Array<{ session: string; deps: CoordRef[] }>;
  const waiting = events.filter((e) => e.type === "waiting") as Array<{ session: string }>;
  if (asks.length)    segs.push(`${asks.length} awaiting your answer — ${asks.map((a) => `${a.session} asks: "${a.question}"`).join("; ")}`);
  if (landed.length)  segs.push(`${landed.length} landed (${landed.join(", ")})`);
  if (blocked.length) segs.push(`${blocked.length} blocked (${blocked.map((b) => `${b.session} on ${b.deps.map(refLabel).join("+")}`).join("; ")})`);
  if (waiting.length) segs.push(`${waiting.length} waiting (${waiting.map((w) => w.session).join(", ")})`);
  if (failed.length)  segs.push(`${failed.length} failed (${failed.join(", ")})`);
  const summary = segs.length ? segs.join("; ") : "new activity";
  const askAction = asks.length
    ? `Answer each asking worker with \`bsc-answer <session>\` (e.g. \`echo "use cursor pagination" | bsc-answer ${asks[0].session}\`) — that resumes them automatically; do not leave them parked. `
    : "";
  return `[coordinator] New worker activity: ${summary}. ${askAction}${DIRECTOR_ACTION}`;
}

/** Build the periodic heartbeat injection (a generic fleet sweep). Single line. */
export function heartbeatDirectorPrompt(): string {
  return `[coordinator] Heartbeat -- sweep the fleet. ${DIRECTOR_ACTION}`;
}

/** Stable key for a pending ask (session + when), so the pump surfaces each ask once. */
export function askKey(a: { session: string; at: number }): string {
  return `${a.session}@${a.at}`;
}

/**
 * Prompt that surfaces unanswered worker questions to the director (#369). Driven by the
 * live `asking` table (state), not edge events, so a pending question is delivered even if
 * it was logged before the pump saw the director or across an app restart. Single line.
 */
export function pendingAskPrompt(asks: AskingSession[]): string {
  const list = asks
    .map((a) => `${a.session} asks: "${a.question}" (answer with bsc-answer ${a.session})`)
    .join("; ");
  return `[coordinator] ${asks.length} worker question(s) awaiting your answer: ${list}. For each, pipe your one-line answer into bsc-answer <session> on stdin; that resumes the worker automatically. Do not leave them parked, and do not ask the user yourself.`;
}

/** Stable key for a received brief (planner + when), so the pump surfaces each brief once. */
export function briefKey(b: { from: string; at: number }): string {
  return `${b.from}@${b.at}`;
}

/**
 * Prompt that surfaces the planner's mid-build plan updates to the director (#2377). Driven
 * by the live `briefs` table (state), not edge events, so a brief is delivered even if it was
 * logged before the pump saw the director or across an app restart — the same restart-safe,
 * must-not-drop posture as {@link pendingAskPrompt}. Each brief may carry a `ref` (a new/
 * updated #issue, contract, or file) the director routes onward via `bsc-assign`. Single line.
 */
export function pendingBriefPrompt(briefs: ReceivedBrief[]): string {
  const list = briefs
    .map((b) => `"${b.body}"${b.ref ? ` [${refLabel(b.ref)}]` : ""}`)
    .join("; ");
  return `[coordinator] The planner pushed ${briefs.length} mid-build plan update(s): ${list}. Reconcile the running plan with each: update the board/issues to match, and route any new or changed work to the owning worker with bsc-assign (open a fresh issue via bsc-issue first when a brief introduces a new #ref). Do not ask the user.`;
}

/** Stable key for an open project request, so the pump surfaces each one once. Keyed on the plan.db
 *  ROW ID, not session+time: the id is the thing the director resolves by, and it is what
 *  `request-resolved` carries, so the key prunes exactly when the request is answered. */
export function requestKey(r: { id: string }): string {
  return `req:${r.id}`;
}

/**
 * Prompt that surfaces open worker->director change requests (#4001).
 *
 * Same restart-safe, must-not-drop posture as {@link pendingAskPrompt}: driven by the live `requests`
 * table, so a request filed before the pump saw the director still lands. It names BOTH of the
 * director's moves explicitly — resolve it, or escalate a genuine tooling gap — because the whole
 * two-lane design (#4000) depends on the director being the escalation point rather than the worker.
 */
export function pendingRequestPrompt(requests: OpenRequest[]): string {
  const list = requests
    .map((r) => `#${r.id} from ${r.from || "a worker"}: "${r.text}"`)
    .join("; ");
  return `[coordinator] ${requests.length} worker change-request(s) awaiting you: ${list}. For each: do the thing if it is yours (branches, board, issues, worktrees are all in your remit), then close it with bsc plan request resolve <id> --note "<what you did>" — the note is the answer the worker reads back. If it is genuinely a gap in the base-studio-code TOOLING rather than this project, escalate it with bsc request new "<gap>" and then resolve the project request noting that you did. Do not ask the user, and do not leave one open.`;
}

/** Coordination events the director should act on (worker-originated asks). Its own
 *  merge/close/wake events are excluded so it is never re-prompted by its own actions. */
const DIRECTOR_RELEVANT = new Set(["landed", "blocked", "waiting", "failed"]);

export interface DirectorTickInput {
  /** All coord.log lines, oldest-first. */
  lines: string[];
  /** How many lines have already been consumed. */
  cursor: number;
  drive: DirectorDrive;
  /** Whether the director pane is idle (safe to inject without interrupting a turn). */
  idle: boolean;
  now: number;
  /** Timestamp of the last injection (0 = never). Gates the heartbeat cadence + cooldown. */
  lastInjectAt: number;
  heartbeatMs: number;
  cooldownMs: number;
}

export interface DirectorTickResult {
  /** The prompt to write to the director's stdin, or null to do nothing this tick. */
  inject: string | null;
  /** New cursor -- events left unconsumed (cursor held) are retried next tick. */
  cursor: number;
  lastInjectAt: number;
}

/**
 * Decide whether to re-prompt the director this tick. Pure: the hook supplies the live
 * inputs (log lines, idle status, clock) and actuates the returned `inject` via pty_write.
 *
 * Event mode holds the cursor when the director is busy or within the cooldown so the
 * pending events are retried once it frees up -- no event is dropped, none double-fires.
 */
export function decideDirectorAction(inp: DirectorTickInput): DirectorTickResult {
  const { lines, cursor, drive, idle, now, lastInjectAt, heartbeatMs, cooldownMs } = inp;
  const end = lines.length;

  if (drive === "off" || drive === "manual") {
    return { inject: null, cursor: end, lastInjectAt };
  }

  if (drive === "heartbeat") {
    if (idle && (lastInjectAt === 0 || now - lastInjectAt >= heartbeatMs)) {
      return { inject: heartbeatDirectorPrompt(), cursor: end, lastInjectAt: now };
    }
    return { inject: null, cursor: end, lastInjectAt };
  }

  // event-driven
  const fresh = lines.slice(cursor)
    .map(parseCoordLine)
    .filter((e): e is CoordEvent => e !== null && DIRECTOR_RELEVANT.has(e.type));
  if (fresh.length === 0) return { inject: null, cursor: end, lastInjectAt };
  if (!idle || now - lastInjectAt < cooldownMs) {
    // Busy or cooling down -- hold the cursor so these events are retried when ready.
    return { inject: null, cursor, lastInjectAt };
  }
  return { inject: eventDirectorPrompt(fresh), cursor: end, lastInjectAt: now };
}
