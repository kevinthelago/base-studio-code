// -- Mobile-push notifications (#199 AC#5 / #366) -------------------------------
// The coordinator must reach the human/director on their phone when a chain needs
// attention -- a dep just LANDED (a parked session is wakeable) or a chain is STUCK
// (a failed dep, or a wait-for deadlock no producer will ever clear). Delivery rides
// the existing tunnel `user_request` -> FCM path (a parked pane flipped to
// awaiting_input with this summary as its prompt; see useCoordinator). Kept pure here
// -- "which sessions alert, with what message" -- so the escalation logic is testable
// without the tunnel. One notification per session, most-severe-wins:
// deadlocked > stalled (both are "stuck"); `ready` comes from a disjoint set (the
// newly-woken waiters, which are no longer parked) so it never collides.
import type {
  Waiter,
  CoordState,
  ProducerOf,
  CoordNotificationKind,
  CoordNotification,
} from "./coordination.types";
import { refKey, isSatisfied } from "./coordinationState";
import { detectDeadlocks, defaultProducerOf } from "./coordinationDeadlock";

function notificationSummary(kind: CoordNotificationKind, session: string, refs: string[]): string {
  const list = refs.join(", ");
  switch (kind) {
    case "ready":
      return `${session}: ${refs.length === 1 ? "dependency" : "dependencies"} landed (${list}) -- ready to resume.`;
    case "stalled":
      return `${session}: blocked chain stalled -- a dependency failed (${list}). Needs attention.`;
    case "deadlocked":
      return `${session}: wait-for deadlock (${list}) -- no producer can clear it. Needs the director.`;
  }
}

/**
 * Derive the push notifications for the current coordinator state (#366): the newly-ready
 * waiters (their gating deps just landed -- wakeable) plus every still-parked waiter whose
 * chain is STUCK -- a failed dep (stalled) or a wait-for cycle (deadlocked). One
 * notification per session, deadlocked taking precedence over stalled (the more severe
 * "no producer will ever clear it"). `ready` is the disjoint list of waiters that just
 * became ready (e.g. {@link ingestCoordLog}'s `ready`, or a satisfy/predicate event's
 * `woken`) -- they're already removed from `s.waiters`, so the ready set and the
 * stuck set never overlap. Pure + deterministic (no IO); the tunnel delivery is a thin
 * layer on top in useCoordinator. `producerOf` resolves deadlock edges (see
 * {@link detectDeadlocks}; defaults to the `session:` self-resolver).
 */
export function coordNotifications(
  s: CoordState,
  ready: Waiter[] = [],
  producerOf: ProducerOf = defaultProducerOf,
): CoordNotification[] {
  const out: CoordNotification[] = [];
  for (const w of ready) {
    const refs = w.deps.map(refKey);
    out.push({ kind: "ready", session: w.session, refs, summary: notificationSummary("ready", w.session, refs), key: `ready:${w.session}` });
  }
  const deadlocked = new Set(detectDeadlocks(s, producerOf).flatMap((d) => d.cycle));
  for (const w of s.waiters) {
    if (deadlocked.has(w.session)) {
      const refs = w.deps.filter((d) => !isSatisfied(s, d)).map(refKey);
      out.push({ kind: "deadlocked", session: w.session, refs, summary: notificationSummary("deadlocked", w.session, refs), key: `deadlocked:${w.session}` });
      continue; // deadlocked outranks stalled -- one notification per session
    }
    const failedRefs = w.deps.filter((d) => s.latches[refKey(d)]?.state === "failed").map(refKey);
    if (failedRefs.length > 0) {
      out.push({ kind: "stalled", session: w.session, refs: failedRefs, summary: notificationSummary("stalled", w.session, failedRefs), key: `stalled:${w.session}` });
    }
  }
  return out;
}
