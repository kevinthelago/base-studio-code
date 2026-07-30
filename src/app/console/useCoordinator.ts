// The always-on coordinator (#199, scoped down in #1039): polls the coordination log and resumes a
// worker the DIRECTOR has answered. It no longer auto-wakes on dependency-landed — the runtime
// dependency-WAIT was removed: planning already defines the integration contracts/seams between
// streams, so workers build against the contract IN PARALLEL rather than parking until an upstream
// lands (see fleet-protocol.md). Mount once (ConsoleWorkspace stays mounted across screens, so the
// coordinator runs regardless of the active screen).
//
// What remains:
//   • Director answer (#369): a worker that asked the director a question (`bsc-ask`) is resumed
//     when the director replies (`bsc-answer`), recency-gated, independent of any toggle.
//   • Mobile push (#366): coordination notifications to a paired phone, deduped + once each — the
//     surviving alert path (a stuck/failed signal still reaches the human).
import { useRef } from "react";
import { useAppStore } from "@/store";
import {
  ingestCoordLog,
  answerWakePrompt,
  assignWakePrompt,
  coordNotifications,
  buildProducerOf,
  producesFromPaneStreams,
} from "@/shared/lib/fleet/coordination";
import { readCoordState } from "@/shared/lib/fleet/useCoordLog";
import { useLogStream } from "@/shared/hooks/useLogStream";
import type { SessionMeta } from "@/features/tunnel";
import { injectWake, actuateWake } from "@/shared/lib/fleet/coordinatorActuate";
import { tunnelStatus, tunnelSetSessions } from "@/features/tunnel";
import { log } from "@/shared/lib/core/log";

// #3638: coord reads are event-driven now — the wake fires on the `logs://coord` change (instant,
// better than the old ~1s poll), plus a mount read + a slow safety-net backstop.
const FRESH_MS = 15 * 60 * 1000;

export function useCoordinator(): void {
  const inFlight = useRef<Set<string>>(new Set());
  // Notification keys already pushed to mobile this app run -- so the poll loop fires
  // each alert exactly once (FCM is a push, not a poll).
  const notified = useRef<Set<string>>(new Set());
  useLogStream("coord", async (isCancelled) => {
    if (isCancelled()) return;
    const res = await readCoordState(1000);
    if (isCancelled() || !res) return;
    const { state, ready, answered, assigned } = res;
    const now = Date.now();
    // #4025 — project the declared-maintenance set into the store. This hook already reduces the
    // whole coord log, so the alternative was a SECOND poll of the same file in the reaper.
    useAppStore.getState().setPaneMaintaining(
      Object.fromEntries(state.maintaining.map((m) => [m.session, true])),
    );

    // A director answer (#369) always resumes the asking worker, recency-gated -- this is the
    // surviving wake path: deferring a worker's question to the director only works if its
    // answer reliably wakes the worker.
    for (const a of answered) {
      if (inFlight.current.has(a.session)) continue;
      if (now - a.at >= FRESH_MS) continue;
      inFlight.current.add(a.session);
      void injectWake(a.session, answerWakePrompt(a))
        .finally(() => inFlight.current.delete(a.session));
    }

    // #4025 — DELIVER ASSIGNMENTS. `bsc-assign` has always produced an `AssignedWork` here and
    // `assignWakePrompt` has always existed, but nothing consumed either: this hook destructured only
    // `answered`. So the director protocol told the director to dispatch with `bsc-assign` in three
    // places, the worker protocol promised workers it would "resume you automatically", and the wire
    // between them was never connected.
    //
    // Delivered via `actuateWake` (kill + relaunch with the prompt BAKED IN), not `injectWake`
    // (type into the live pane). That choice is what makes a REAPED worker reachable: a maintaining
    // session's PTY is gone, so an injected prompt would be dropped by the backend ("write to missing
    // session"). A relaunch works identically whether the pane is live, dormant, or reaped — and it
    // is the same mechanism the fleet kickoff uses, so there is no readiness race to lose the
    // assignment to.
    for (const a of assigned) {
      if (inFlight.current.has(a.session)) continue;
      if (now - a.at >= FRESH_MS) continue;
      inFlight.current.add(a.session);
      void actuateWake(a.session, assignWakePrompt(a), useAppStore.getState().wakePane)
        .then((ok) => { if (!ok) log.warn(`assign: no open tab hosts ${a.session} — assignment not delivered`); })
        .finally(() => inFlight.current.delete(a.session));
    }

    // Mobile push (#366): alerts to a paired phone, deduped + once each.
    void pushNotifications(state, ready, notified.current).catch((e) =>
      log.error(`coordinator: notify failed: ${e}`),
    );
  }, []);
}

/**
 * Push the current coordination notifications to a paired phone, firing each alert once.
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
