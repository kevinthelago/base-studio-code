// The warm-pool PLAN for debugger overflow sessions (#3535, slice 2) — decides, each poll, whether to
// spawn ONE more overflow session, which sessions to close, and each live session's reconciled state.
//
// The MODEL (approved): the standing debug session (`DebugSessionMount`) is the always-on primary — it
// self-serves the request queue. This pool is the OVERFLOW: when the primary is busy and there is more
// CLAIMABLE work, it spins up an additional generic-charter debugger; when all are busy it spins up
// another, up to a hard cap; each overflow session claims a request, fixes it, resolves it with a note,
// and is CLOSED when its claim resolves. So this module never touches the standing session — it only
// sizes the overflow beside it.
//
// PACED, not blasted: at most ONE session is "warming" (launched, not yet claimed) at a time, so the
// pool grows one step per cycle — "prefer this one until it's running; if it's running, spin up another"
// — rather than launching `cap` sessions the instant a burst of requests lands.
//
// PURE and separate from the launcher (mirrors #3498's planner/launcher split): every rule that bounds
// blast radius — the gate, the cap, the pacing, the reap — is here and exhaustively testable without
// starting a single session. The mount's only job is to obey the plan.

import { autoSpawnDecision, AUTO_SPAWNABLE_ROLE } from "./autoSpawn";

/** A request row as `bsc request list --json` returns it (the fields the pool reads). */
export interface RequestRow {
  id: number;
  /** `open` (claimable) · `claimed` (a session holds it) · `resolved` (done). */
  status: string;
  /** The pane id of the session holding a claimed request (#3535 `claimed_by`). */
  claimedBy?: string | null;
}

/** One overflow session the pool has launched (NOT the standing session). */
export interface PoolSession {
  paneId: string;
  /** The request id this session has claimed, or null while WARMING (launched, hasn't claimed yet). */
  claimedId: number | null;
  /** Consecutive polls this session has been warming with no claim — a session that never claims (it
   *  lost the race, or the queue drained before it ran `claim`) is reaped once this exceeds
   *  {@link MAX_WARM_POLLS}, so a warming slot can't wedge the pacing forever. Ignored once claimed. */
  pollsWarming: number;
}

export interface PoolPlanInput {
  /** The full request list (`bsc request list --json`), any status. */
  requests: RequestRow[];
  /** The overflow sessions currently launched, with their last-known state. */
  sessions: PoolSession[];
  /** The Settings toggle (`autoSpawnDebugSessions`). Anything but `true` is off. */
  enabled: boolean | null | undefined;
  /** Max TOTAL concurrent debuggers, INCLUDING the always-on standing session — so overflow is capped
   *  at `cap - 1`. Bounds a runaway: one never-resolving request can never fill the machine. */
  cap: number;
}

export interface PoolPlan {
  /** Launch ONE more overflow session this cycle? Never more than one — the pool grows one step/poll. */
  spawn: boolean;
  /** Overflow pane ids to CLOSE now: their claim resolved (work done), or they warmed out / lost it. */
  close: string[];
  /** Every still-live overflow session, with `claimedId`/`pollsWarming` reconciled against the queue.
   *  The mount replaces its tracked set with this (then appends a freshly-launched one when `spawn`). */
  sessions: PoolSession[];
  /** When not spawning, why — so a stalled pool is diagnosable, never a silent non-decision. */
  reason?: string;
  /** True when the ONLY thing blocking a spawn is the cap: there is claimable work and no session is
   *  warming, but the overflow is already at `cap - 1`. This is the "we need more but can't" signal the
   *  mount logs (#3535) — capacity pressure the user asked to be told about. */
  atCapacity: boolean;
  /** How many claimable (`open`) requests are waiting with no session free to take them — the size of
   *  the pressure when {@link atCapacity}. Zero otherwise. */
  waiting: number;
}

/** A warming session is reaped after this many consecutive claim-less polls (~1 min at a 20s poll). */
export const MAX_WARM_POLLS = 3;

/**
 * Plan the overflow pool for one cycle (#3535). Pure — starts and stops nothing.
 *
 * Steps:
 *  1. **Gate.** Auto-spawn off ⇒ spawn nothing and CLOSE every overflow session (the pool drains to just
 *     the standing session), each carrying the gate's own reason.
 *  2. **Reconcile + reap.** For each session: if the queue shows a request claimed BY it, it's busy on
 *     that id; if it previously held a claim that's no longer its (resolved / unclaimed / regrabbed),
 *     it's done → close; if it's still warming, bump the counter and close only once it exceeds
 *     {@link MAX_WARM_POLLS}.
 *  3. **Pace + cap.** Spawn one more only when there is claimable (`open`) work, NO session is currently
 *     warming, and the live count is under `cap - 1`.
 */
export function planPool(input: PoolPlanInput): PoolPlan {
  const gate = autoSpawnDecision({ role: AUTO_SPAWNABLE_ROLE, enabled: input.enabled });
  if (!gate.allowed) {
    return {
      spawn: false,
      close: input.sessions.map((s) => s.paneId),
      sessions: [],
      reason: gate.reason,
      atCapacity: false,
      waiting: 0,
    };
  }

  // paneId → the request id it currently holds (claimed).
  const heldByPane = new Map<string, number>();
  for (const r of input.requests) {
    if (r.status === "claimed" && r.claimedBy) heldByPane.set(r.claimedBy, r.id);
  }

  const kept: PoolSession[] = [];
  const close: string[] = [];
  for (const s of input.sessions) {
    const held = heldByPane.get(s.paneId);
    if (held != null) {
      kept.push({ paneId: s.paneId, claimedId: held, pollsWarming: 0 }); // busy on `held`
    } else if (s.claimedId != null) {
      close.push(s.paneId); // had a claim, no longer holds it ⇒ resolved/done ⇒ reap
    } else {
      const polls = s.pollsWarming + 1;
      if (polls > MAX_WARM_POLLS) close.push(s.paneId); // warmed out — never claimed anything
      else kept.push({ paneId: s.paneId, claimedId: null, pollsWarming: polls });
    }
  }

  const claimable = input.requests.filter((r) => r.status === "open").length;
  const warming = kept.filter((s) => s.claimedId == null).length;
  const overflowCap = Math.max(0, (Number.isFinite(input.cap) ? Math.trunc(input.cap) : 0) - 1);

  let reason: string | undefined;
  if (claimable === 0) reason = "no claimable (open) requests";
  else if (warming > 0) reason = "a session is still warming — pace one at a time";
  else if (kept.length >= overflowCap) reason = `at the overflow cap (${overflowCap})`;

  // Capacity pressure: claimable work AND nothing warming AND we are wedged against the cap. That is the
  // one non-spawn where the ANSWER is "we need more but may not have them" — everything under the cap
  // spawns next cycle instead. `waiting` sizes it (the claimable requests no session can take right now).
  const atCapacity = claimable > 0 && warming === 0 && kept.length >= overflowCap;
  return { spawn: reason === undefined, close, sessions: kept, reason, atCapacity, waiting: atCapacity ? claimable : 0 };
}
