// The plan for request debugger sessions (#one-request-one-debug-session) — decides, each poll, which
// requests need a session started, which sessions to close, and the reconciled live set.
//
// THE MODEL: 1:1. Every request the app has claimed gets exactly ONE session, bound to it and named for
// it (`debug-studio:req-<id>`), and that session is closed when THAT request resolves. There is no pool,
// no cap, no pacing and no reaper.
//
// WHAT THIS REPLACES, AND WHY EACH PIECE WENT. #3535 ran a WARM POOL: generic sessions that claimed work
// after launching, paced one-at-a-time and capped at three total.
//   * The CLAIM RACE is gone because the app claims first and spawns for what it got, so a session never
//     competes for its own work. `bsc request claim` takes the OLDEST open request and is atomic, which
//     is what makes "claim, then spawn for the id it returned" safe against the standing debug session
//     doing the same thing — whoever claims first has it, and the other simply sees it held.
//   * The REAPER (`pollsWarming`/`MAX_WARM_POLLS`) is gone with it. It existed solely to clean up a
//     session that launched, lost the race and would otherwise idle forever with nothing to do. An
//     assigned session always has work.
//   * The PACING is gone: it throttled how fast the pool grew toward a cap, and there is no cap.
//   * The CAP is gone BY DECISION, not by oversight. #3535's cap existed so "a never-resolving request
//     must never be able to fill the machine with debuggers"; at 1:1 the concurrency IS the number of
//     unresolved claimed requests, which the maintainer accepted on the grounds that this queue stays
//     small (44 requests all-time, 4 open when this shipped). If it ever grows, the fix is a queue in
//     front of the spawn — not a return to claiming, which is what made a session's identity meaningless.
//
// PURE and separate from the launcher (mirrors #3498's planner/launcher split): every rule that bounds
// blast radius is here and exhaustively testable without starting a single session. The mount obeys it.

import { autoSpawnDecision, AUTO_SPAWNABLE_ROLE } from "./autoSpawn";
// ABSOLUTE, not `./requestSpawn`: that module has no file — it is a graph record with `provides`, and
// only the `@/…` specifier resolves to it (through tsconfig paths + the emitted record cache).
import { requestPaneId, requestIdFromPaneId } from "@/shared/lib/session/requestSpawn";

/** A request row as `bsc request list --json` returns it (the fields the plan reads). */
export interface RequestRow {
  id: number;
  /** `open` (nobody holds it) · `claimed` (a session holds it) · `resolved` (done). */
  status: string;
  /** The pane id of the session holding a claimed request (#3535 `claimed_by`). */
  claimedBy?: string | null;
}

/** One live request session. Its `paneId` encodes the request, so the id is not stored twice. */
export interface RequestSession {
  paneId: string;
}

export interface RequestSessionPlanInput {
  /** The full request list (`bsc request list --json`), any status. */
  requests: RequestRow[];
  /** The sessions currently launched. */
  sessions: RequestSession[];
  /** The Settings toggle (`autoSpawnDebugSessions`). Anything but `true` is off. */
  enabled: boolean | null | undefined;
}

export interface RequestSessionPlan {
  /** Requests that are claimed for us and have no session yet — start one per id, all of them, now. */
  start: number[];
  /** Pane ids to CLOSE: their request resolved, vanished, or the gate turned off. */
  close: string[];
  /** Every still-live session. The mount replaces its tracked set with this, then appends what it starts. */
  sessions: RequestSession[];
  /** When starting nothing, why — so a stalled queue is diagnosable, never a silent non-decision. */
  reason?: string;
}

/**
 * Plan the request sessions for one cycle. Pure — starts and stops nothing.
 *
 * @param input the queue, the live sessions, and the auto-spawn gate.
 * @returns which requests need a session, which panes to close, and the reconciled live set.
 *
 * Steps:
 *  1. **Gate.** Auto-spawn off ⇒ start nothing and CLOSE every session, carrying the gate's own reason.
 *  2. **Reconcile.** A session survives only while its request is still unresolved and still present; a
 *     session whose request resolved (or was removed outright) is closed.
 *  3. **Start.** Every CLAIMED request with no live session gets one. All of them in the same cycle —
 *     there is nothing to pace against.
 *
 * `open` requests are deliberately NOT started: an unclaimed request is one nobody holds, and the app
 * claims it (atomically, obtaining the id) BEFORE asking for a session. Planning off `claimed` is what
 * keeps this pure — the claim is the side effect, and it stays in the mount.
 */
export function planRequestSessions(input: RequestSessionPlanInput): RequestSessionPlan {
  const gate = autoSpawnDecision({ role: AUTO_SPAWNABLE_ROLE, enabled: input.enabled });
  if (!gate.allowed) {
    return { start: [], close: input.sessions.map((s) => s.paneId), sessions: [], reason: gate.reason };
  }

  // The requests still worth holding a session for: claimed, not resolved. A request that VANISHED from
  // the list (`bsc request remove`, or a prune) is absent here too, which is what closes its session —
  // an unknown id must not keep a session alive forever.
  const liveIds = new Set(input.requests.filter((r) => r.status === "claimed").map((r) => r.id));

  const kept: RequestSession[] = [];
  const close: string[] = [];
  for (const s of input.sessions) {
    const id = requestIdFromPaneId(s.paneId);
    if (id != null && liveIds.has(id)) kept.push(s);
    else close.push(s.paneId);
  }

  const held = new Set(kept.map((s) => requestIdFromPaneId(s.paneId)));
  const start = [...liveIds].filter((id) => !held.has(id)).sort((a, b) => a - b);

  return {
    start,
    close,
    sessions: kept,
    reason: start.length === 0 ? (liveIds.size === 0 ? "no claimed requests" : "every claimed request already has a session") : undefined,
  };
}

/** The pane a request's session runs in — re-exported so the mount has one import for the plan + its ids. */
export { requestPaneId };
