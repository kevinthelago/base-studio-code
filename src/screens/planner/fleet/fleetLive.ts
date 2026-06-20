// Pure projection: CoordState + PaneDescriptors → FleetSession[] for the mobile tunnel (F2).
//
// The desktop Zustand store owns the authoritative CoordState (produced by ingestCoordLog /
// applyCoordEvent); this module maps it to the flat wire shape the tunnel broadcasts to
// mobile. It is a pure function (no IO, no store imports) so it's unit-testable and can run
// on every store tick without side-effects.

import type { CoordState, Waiter, WaitingSession, AskingSession } from "../../../lib/coordination";
import { refKey } from "../../../lib/coordination";
import type { FleetSession } from "../../../lib/tunnelClient";

/** Build the wire `FleetSession` for one dep-blocked waiter. */
function fromWaiter(w: Waiter, now: number): FleetSession {
  return {
    session: w.session,
    status: "blocked",
    blockedOn: w.deps.map(refKey),
    waitReason: null,
    question: null,
    at: w.registeredAt ?? now,
  };
}

/** Build the wire `FleetSession` for a session paused for the user (#297). */
function fromWaiting(w: WaitingSession): FleetSession {
  return {
    session: w.session,
    status: "waiting",
    blockedOn: [],
    waitReason: w.reason || null,
    question: null,
    at: w.at,
  };
}

/** Build the wire `FleetSession` for a session that asked the director (#369). */
function fromAsking(a: AskingSession): FleetSession {
  return {
    session: a.session,
    status: "asking",
    blockedOn: [],
    waitReason: null,
    question: a.question || null,
    at: a.at,
  };
}

/**
 * Project a `CoordState` into a `FleetSession[]` for the tunnel fleet roster (F2).
 *
 * Precedence when the same session appears in multiple lists (should not happen in a
 * well-formed state, but the asking list takes priority since it is the most specific):
 *   asking > waiting > blocked
 *
 * Sessions that are `running` or `idle` — the absence of any park record — are not tracked
 * here. The mobile fleet view shows only sessions with a notable status; running/idle rows
 * come from the pane list already sent as `pane_list` / `session_state`.
 *
 * @param coord  The current coordinator state (from the store's `coordState`).
 * @param now    ms-epoch timestamp used to stamp entries that lack one.
 */
export function projectFleetSessions(coord: CoordState, now: number = Date.now()): FleetSession[] {
  const out = new Map<string, FleetSession>();

  // Lowest precedence: dep-blocked waiters.
  for (const w of coord.waiters) {
    out.set(w.session, fromWaiter(w, now));
  }

  // Medium precedence: user-waiting sessions.
  for (const w of coord.waiting) {
    out.set(w.session, fromWaiting(w));
  }

  // Highest precedence: asking sessions.
  for (const a of coord.asking) {
    out.set(a.session, fromAsking(a));
  }

  return [...out.values()];
}
