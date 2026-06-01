// The always-on coordinator (#199): polls the coordination log and, when auto-wake is on,
// relaunches any session whose deps just landed. Idempotent (the `woke` event), gated on a
// recency window so an app restart can't relaunch long-abandoned parks, and bounded by an
// in-flight set so a slow wake isn't fired twice. Mount once (ConsoleScreen stays mounted
// across screens, so the coordinator runs regardless of the active screen).
//
// Each poll also runs the predicate satisfy path (#365): any still-pending `predicate:` dep
// is re-checked against the repo via the host, and a predicate that now holds satisfies its
// latch and unblocks its waiters -- the polled third satisfy path alongside merged/closed/
// landed (see applyPredicates).
//
// It ALSO pushes coordination notifications to a paired phone (#366): a dep just landed
// (a parked session is wakeable) or a chain is stuck (a failed dep / a wait-for deadlock).
// Delivery reuses the existing tunnel `user_request` -> FCM path -- the affected pane is
// flipped to `awaiting_input` with the notification summary as its prompt via
// `tunnelSetSessions`, so the relay fires `user_request` (and FCM when the mobile is
// registered) exactly as it does for a y/n confirmation. Each alert fires once (deduped by
// the notification's stable key). Notifications fire regardless of auto-wake -- a stuck
// chain must reach the human even when auto-wake is off -- so only the relaunch is gated.
import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import {
  ingestCoordLog,
  wakePromptFor,
  isFreshlyReady,
  emptyCoordState,
  coordNotifications,
  buildProducerOf,
  producesFromPaneStreams,
  evaluatePredicates,
  pendingPredicateExprs,
} from "./coordination";
import type { Waiter } from "./coordination";
import type { SessionMeta } from "./tunnel";
import { actuateWake } from "./coordinatorActuate";
import { tunnelStatus, tunnelSetSessions } from "./tunnelClient";
import { log } from "./log";

const POLL_MS = 3000;
const FRESH_MS = 15 * 60 * 1000;

export function useCoordinator(): void {
  const inFlight = useRef<Set<string>>(new Set());
  // Notification keys already pushed to mobile this app run -- so a 3s poll loop fires
  // each ready/stalled/deadlocked alert exactly once (FCM is a push, not a poll).
  const notified = useRef<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      const lines = await invoke<string[]>("read_coord_log", { limit: 1000 }).catch(() => null);
      if (cancelled || !lines) return;
      const ingested = ingestCoordLog(lines, emptyCoordState());
      const now = Date.now();

      // Predicate satisfy path (#365): re-check every still-pending `predicate:` dep against
      // the repo via the host, satisfying the latches that now hold and surfacing the waiters
      // they unblock -- the polled third satisfy path alongside merged/closed/landed. Folded
      // into `ready` so a predicate-unblocked session notifies + auto-wakes like any other.
      const { state, ready } = await applyPredicates(ingested.state, ingested.ready, now);
      if (cancelled) return;

      // Mobile push (#366): ready/blocked alerts to a paired phone, deduped + once each.
      // Runs regardless of auto-wake so a stalled/deadlocked chain still reaches the human.
      void pushNotifications(state, ready, notified.current).catch((e) =>
        log.error(`coordinator: notify failed: ${e}`),
      );

      // Auto-wake (#199): relaunch freshly-ready parked sessions when enabled.
      if (!useAppStore.getState().coordAutoWake) return;
      for (const w of ready) {
        if (inFlight.current.has(w.session)) continue;
        if (!isFreshlyReady(w, state, now, FRESH_MS)) continue;
        inFlight.current.add(w.session);
        void actuateWake(w.session, wakePromptFor(w, state), useAppStore.getState().wakePane)
          .finally(() => inFlight.current.delete(w.session));
      }
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
}

/**
 * Push the current ready/stuck notifications to a paired phone, firing each alert once.
 * No-op unless the tunnel is running (no phone paired -> nothing to deliver). Flips each
 * affected pane to `awaiting_input` with the summary as its prompt so the existing relay
 * `user_request` -> FCM path delivers it (see tunnel_set_sessions in src-tauri/src/tunnel.rs).
 */
async function pushNotifications(
  state: ReturnType<typeof ingestCoordLog>["state"],
  ready: ReturnType<typeof ingestCoordLog>["ready"],
  notified: Set<string>,
): Promise<void> {
  const producerOf = buildProducerOf(
    producesFromPaneStreams(useAppStore.getState().fleetPaneStreams),
  );
  const fresh = coordNotifications(state, ready, producerOf).filter((n) => !notified.has(n.key));
  if (fresh.length === 0) return;
  const status = await tunnelStatus().catch(() => null);
  if (!status?.running) return; // no phone paired -> leave unmarked so it delivers once paired
  const nowIso = new Date().toISOString();
  const sessions: SessionMeta[] = fresh.map((n) => ({
    paneId: n.session,
    status: "awaiting_input",
    currentTask: "coordinator",
    lastActivity: nowIso,
    prompt: n.summary,
  }));
  await tunnelSetSessions(sessions);
  for (const n of fresh) notified.add(n.key);
}

/**
 * Run the predicate satisfy path for this poll: ask the host to evaluate the still-pending
 * `predicate:` deps, then satisfy the latches that now hold and merge the freshly-unblocked
 * waiters into `ready`. The host check (`coord_eval_predicates`) inspects the repo
 * (file-exists / symbol / tests-pass / custom) and returns a map of expr -> holds. Until that
 * backend command exists the invoke rejects and we treat every predicate as not-yet-evaluable
 * (left pending, retried next poll) -- a safe no-op that never falsely satisfies. The host
 * round-trip is skipped entirely when nothing is predicate-gated.
 */
async function applyPredicates(
  state: ReturnType<typeof ingestCoordLog>["state"],
  ready: Waiter[],
  now: number,
): Promise<{ state: ReturnType<typeof ingestCoordLog>["state"]; ready: Waiter[] }> {
  const exprs = pendingPredicateExprs(state);
  if (exprs.length === 0) return { state, ready };
  const holds = await invoke<Record<string, boolean | undefined>>("coord_eval_predicates", {
    exprs,
  }).catch(() => null);
  if (!holds) return { state, ready }; // host can't evaluate yet -> defer, retry next poll
  const { state: next, woken } = evaluatePredicates(state, (e) => holds[e], now);
  return { state: next, ready: woken.length ? [...ready, ...woken] : ready };
}
