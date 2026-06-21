// The always-on coordinator (#199, scoped down in #1039): polls the coordination log and resumes a
// worker the DIRECTOR has answered. It no longer auto-wakes on dependency-landed — the runtime
// dependency-WAIT was removed: planning already defines the integration contracts/seams between
// streams, so workers build against the contract IN PARALLEL rather than parking until an upstream
// lands (see fleet-protocol.md). Mount once (ConsoleScreen stays mounted across screens, so the
// coordinator runs regardless of the active screen).
//
// What remains:
//   • Director answer (#369): a worker that asked the director a question (`bsc-ask`) is resumed
//     when the director replies (`bsc-answer`), recency-gated, independent of any toggle.
//   • Mobile push (#366): coordination notifications to a paired phone, deduped + once each — the
//     surviving alert path (a stuck/failed signal still reaches the human).
import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store";
import {
  ingestCoordLog,
  answerWakePrompt,
  emptyCoordState,
  coordNotifications,
  buildProducerOf,
  producesFromPaneStreams,
} from "./coordination";
import type { SessionMeta } from "../tunnel/tunnel";
import { injectWake } from "./coordinatorActuate";
import { tunnelStatus, tunnelSetSessions } from "../tunnel/tunnelClient";
import { log } from "../core/log";

const POLL_MS = 1000;  // snappy: a director answer should wake the worker within ~1s
const FRESH_MS = 15 * 60 * 1000;

export function useCoordinator(): void {
  const inFlight = useRef<Set<string>>(new Set());
  // Notification keys already pushed to mobile this app run -- so the poll loop fires
  // each alert exactly once (FCM is a push, not a poll).
  const notified = useRef<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      const lines = await invoke<string[]>("read_coord_log", { limit: 1000 }).catch(() => null);
      if (cancelled || !lines) return;
      const { state, ready, answered } = ingestCoordLog(lines, emptyCoordState());
      const now = Date.now();

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

      // Mobile push (#366): alerts to a paired phone, deduped + once each.
      void pushNotifications(state, ready, notified.current).catch((e) =>
        log.error(`coordinator: notify failed: ${e}`),
      );
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
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
