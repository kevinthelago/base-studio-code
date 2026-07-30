// The director pump (#366, #369, #371): drives the fleet's async-integrator "director"
// session so it does not just idle after its kickoff. Two delivery paths, injected via
// pty_write into the director pane:
//
//  1. PENDING WORKER QUESTIONS (state-based) -- unanswered `bsc-ask` questions are
//     re-derived from the FULL coord log every tick (ingestCoordLog -> state.asking), so a
//     question is delivered even if it was logged before the pump first saw the director or
//     across an app restart. Each (pane, ask) is surfaced once; the key is pruned when the
//     ask is answered/woken so a re-ask re-surfaces. Delivered when the director is idle, or
//     after ASK_FALLBACK_MS even if it is not (the TUI may never trip the 1.5s idle gate;
//     Claude Code queues input typed mid-turn). This is the must-not-drop case.
//  2. NOTIFICATIONS + HEARTBEAT (cursor-based) -- landed/blocked/failed activity and the
//     periodic sweep, via decideDirectorAction (idle-gated).
//
// Mounted once in ConsoleWorkspace (which stays mounted across screens). Pure logic lives in
// directorDrive.ts + coordination.ts; this is the thin Tauri/React actuator.
import { useRef, type RefObject } from "react";
import { useAppStore } from "@/store";
import { useLogStream } from "@/shared/hooks/useLogStream";
import { injectPrompt } from "@/shared/lib/fleet/paneInject";
import { readCoordState } from "@/shared/lib/fleet/useCoordLog";
import {
  decideDirectorAction, resolveDirectorDrive, askKey, pendingAskPrompt,
  briefKey, pendingBriefPrompt,
  requestKey, pendingRequestPrompt,
  shouldRemind, idleReminderPrompt, ASK_REMINDER_MS,
  DEFAULT_HEARTBEAT_MS, INJECT_COOLDOWN_MS,
} from "@/features/planner";

// #3638: event-driven on the `logs://coord` change (+ mount + slow backstop), not a fixed poll.

interface PaneCursor { cursor: number; lastInjectAt: number; }

export function useDirectorPump(paneStatusesRef: RefObject<Record<string, "run" | "on" | "idle">>): void {
  const cursors = useRef<Map<string, PaneCursor>>(new Map());
  const inFlight = useRef<Set<string>>(new Set());
  // Per (pane|ask) keys already surfaced, pruned when the ask is no longer pending — so a
  // question is injected exactly once (not re-queued every 3s) until it is answered.
  const surfaced = useRef<Set<string>>(new Set());
  // #4019 — when each pane was last REMINDED about outstanding asks/requests. Separate from the
  // cursor's `lastInjectAt` (which paces notifications + the heartbeat) so a reminder is not
  // starved by unrelated traffic, and vice versa.
  const remindedAt = useRef<Map<string, number>>(new Map());
  useLogStream("coord", async (isCancelled) => {
    if (isCancelled()) return;
    const drives = useAppStore.getState().paneDirectorDrive;
    const paneIds = Object.keys(drives);
    if (paneIds.length === 0) return;
    const res = await readCoordState(2000);
    if (isCancelled() || !res) return;
    const now = Date.now();
    const statuses = paneStatusesRef.current ?? {};

    // Pending unanswered questions + planner briefs, re-derived from the whole log
    // (restart-safe). Both surface state-based (not edge events) and are guarded once-per-pane.
    const { lines, state } = res;
    const pendingAsks = state.asking;
    const pendingKeys = new Set([...pendingAsks.map(askKey), ...state.briefs.map(briefKey), ...state.requests.map(requestKey)]);
    for (const k of [...surfaced.current]) {
      const bar = k.indexOf("|");
      if (bar >= 0 && !pendingKeys.has(k.slice(bar + 1))) surfaced.current.delete(k);
    }

    for (const paneId of paneIds) {
      if (inFlight.current.has(paneId)) continue;
      const drive = resolveDirectorDrive(drives[paneId]);
      const idle = statuses[paneId] === "idle";

      // 1) Deliver pending worker questions immediately -- the must-not-drop case. No idle
      // gate: Claude Code queues input typed mid-turn, so the question lands as the
      // director's next message. The surfaced set keeps it to exactly one injection per ask.
      if (drive === "event" || drive === "heartbeat") {
        const fresh = pendingAsks.filter((a) => !surfaced.current.has(paneId + "|" + askKey(a)));
        if (fresh.length > 0) {
          for (const a of fresh) surfaced.current.add(paneId + "|" + askKey(a));
          inFlight.current.add(paneId);
          void injectPrompt(paneId, pendingAskPrompt(fresh))
            .catch(() => {})
            .finally(() => inFlight.current.delete(paneId));
          continue; // one injection per pane per tick
        }

        // 1b) Deliver the planner's mid-build briefs (#2377) the same must-not-drop way — the
        // director reconciles the running plan and routes any carried ref onward via bsc-assign.
        const freshBriefs = state.briefs.filter((b) => !surfaced.current.has(paneId + "|" + briefKey(b)));
        if (freshBriefs.length > 0) {
          for (const b of freshBriefs) surfaced.current.add(paneId + "|" + briefKey(b));
          inFlight.current.add(paneId);
          void injectPrompt(paneId, pendingBriefPrompt(freshBriefs))
            .catch(() => {})
            .finally(() => inFlight.current.delete(paneId));
          continue; // one injection per pane per tick
        }

        // 1c) Deliver open worker CHANGE REQUESTS (#4001) the same must-not-drop way. Unlike a brief
        // (append-only, never auto-cleared) a request genuinely closes: `request-resolved` removes it
        // from `state.requests`, which prunes the surfaced key above — so a later re-file of the same
        // ask surfaces again instead of being suppressed forever by a stale key.
        const freshRequests = state.requests.filter((r) => !surfaced.current.has(paneId + "|" + requestKey(r)));
        if (freshRequests.length > 0) {
          for (const r of freshRequests) surfaced.current.add(paneId + "|" + requestKey(r));
          inFlight.current.add(paneId);
          void injectPrompt(paneId, pendingRequestPrompt(freshRequests))
            .catch(() => {})
            .finally(() => inFlight.current.delete(paneId));
          continue; // one injection per pane per tick
        }
      }

      // 1d) IDLE REMINDER (#4019) — the backstop for a delivery that did not take. Each ask/request is
      // injected exactly once by the blocks above; if the director was mid-turn or simply did not act,
      // nothing above will ever say it again, and the worker stays parked (measured: 44 asks, 20
      // answers). So while the director is IDLE and anything is still outstanding, re-state it on a
      // rate-limited cadence. Runs for every drive except off/manual — an `event` director has no
      // heartbeat at all, which is precisely the case that went silent.
      if (drive !== "off" && drive !== "manual") {
        const pending = pendingAsks.length + state.requests.length;
        if (shouldRemind({ idle, pending, now, lastRemindAt: remindedAt.current.get(paneId) ?? 0, everyMs: ASK_REMINDER_MS })) {
          remindedAt.current.set(paneId, now);
          inFlight.current.add(paneId);
          void injectPrompt(paneId, idleReminderPrompt(pendingAsks, state.requests))
            .catch(() => {})
            .finally(() => inFlight.current.delete(paneId));
          continue; // one injection per pane per tick
        }
      }

      // 2) Notifications + heartbeat (cursor-based). First sight seeds the cursor at the
      // current end so we only NOTIFY on activity after launch (asks are handled above).
      let prev = cursors.current.get(paneId);
      if (!prev) { prev = { cursor: lines.length, lastInjectAt: now }; cursors.current.set(paneId, prev); }
      const action = decideDirectorAction({
        lines,
        cursor: prev.cursor,
        drive,
        idle,
        now,
        lastInjectAt: prev.lastInjectAt,
        heartbeatMs: DEFAULT_HEARTBEAT_MS,
        cooldownMs: INJECT_COOLDOWN_MS,
      });
      cursors.current.set(paneId, { cursor: action.cursor, lastInjectAt: action.lastInjectAt });
      if (action.inject) {
        inFlight.current.add(paneId);
        void injectPrompt(paneId, action.inject)
          .catch(() => {})
          .finally(() => inFlight.current.delete(paneId));
      }
    }
  }, [paneStatusesRef]);
}
