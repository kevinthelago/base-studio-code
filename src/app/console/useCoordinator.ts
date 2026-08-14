// The always-on coordinator (#199, scoped down in #1039, and again in
// #coordinator-stops-waking-sessions): polls the coordination log, projects the maintenance set, and
// tells the HUMAN. It no longer resumes anything.
//
// WHAT IT USED TO DO, AND WHY THAT WAS WRONG. Two loops lived here: a `bsc-answer` fired `injectWake`
// into the asking worker, and a `bsc-assign` fired `actuateWake` (kill + relaunch with the prompt
// baked in) at the assignee. Both were recency-gated on FRESH_MS (15 minutes) — and that gate was the
// bug, not the safeguard it looked like. This hook re-derives from the WHOLE coord log on mount, so
// starting the app replayed a quarter-hour of coordination traffic as live wakes: five to nine panes
// opening a Claude turn within the same second, repeatedly, with nobody having clicked anything. That
// is the boot-time cause the maintainer reported as "sessions automatically start on app start".
//
// THE RULE NOW: the app never resumes a session. Only the user does — the Coordination inbox's Wake
// button, or a director running `bsc fleet wake <pane>` on purpose. Telling a person something
// happened is NOT waking a session, so both surviving paths stay:
//   • the maintenance projection (#4025) — the reaper needs it, and it moves no session;
//   • mobile push (#366) — a stuck/failed signal still reaches the human, deduped + once each.
//
// NOTHING IS LOST from the record: asks, answers and assignments are all still in the coord log and
// still reach the Coordination inbox. What changed is who acts on them.
//
// THE CONSEQUENCE IS REAL AND IS HANDLED IN PROSE, not left implicit: an assignment no longer resumes
// its worker, so the director/worker protocols that promised "resumes you automatically" were updated
// in the same change. A promise the code no longer keeps is how a fleet stalls silently, waiting on a
// wake that never comes.
import { useAppStore } from "@/store";
import { ingestCoordLog, coordNotifications, buildProducerOf, producesFromPaneStreams, refusalKey } from "@/shared/lib/fleet/coordination";
import { readCoordState } from "@/shared/lib/fleet/useCoordLog";
import { useLogStream } from "@/shared/hooks/useLogStream";
import type { SessionMeta } from "@/features/tunnel";
import { tunnelStatus, tunnelSetSessions } from "@/features/tunnel";
import { log } from "@/shared/lib/core/log";
import { useRef } from "react";

export function useCoordinator(): void {
  // Notification keys already pushed to mobile this app run -- so the loop fires each alert exactly
  // once (FCM is a push, not a poll).
  const notified = useRef<Set<string>>(new Set());
  // The same guard, for the same reason, on the refusal report
  // (#the-refusal-warning-replays-the-whole-log-every-minute). Both loops below read a log that is
  // re-derived WHOLE on every read; the push path had this from the start and the report did not.
  const warnedRefusals = useRef<Set<string>>(new Set());
  useLogStream("coord", async (isCancelled) => {
    if (isCancelled()) return;
    const res = await readCoordState(1000);
    if (isCancelled() || !res) return;
    const { state, ready, refused } = res;
    // CROSS-PROJECT REFUSALS (#coord-log-is-app-wide-answers-cross-projects) are REPORTED, not
    // dropped. A silently swallowed answer looks to the sending director exactly like a delivered
    // one, so it would go on believing it had unblocked a worker it never reached — and the worker's
    // real director would never know it still owed a reply.
    //
    // ONCE EACH, though (#the-refusal-warning-replays-the-whole-log-every-minute). `refused` is
    // re-derived from the WHOLE tail on every read and nothing prunes those lines out of it, so
    // reporting unguarded meant re-announcing the same fixed, months-old events on every change event
    // AND on `useLogStream`'s 60s backstop — measured at 1,729 warnings from 19 real refusals, a
    // block of 19 every minute for as long as the app ran. Keyed per EVENT (see `refusalKey`), so a
    // genuine recurrence still warns; the pruning of the LOG is not this hook's business.
    for (const r of refused) {
      const key = refusalKey(r);
      if (warnedRefusals.current.has(key)) continue;
      warnedRefusals.current.add(key);
      log.warn(
        `coordination: refused a cross-project ${r.kind} — ${r.from} tried to reach ${r.target}, ` +
        `which belongs to another project. Coordination is scoped to the project that raised it.`,
      );
    }
    // #4025 — project the declared-maintenance set into the store. This hook already reduces the
    // whole coord log, so the alternative was a SECOND poll of the same file in the reaper.
    useAppStore.getState().setPaneMaintaining(
      Object.fromEntries(state.maintaining.map((m) => [m.session, true])),
    );

    // Mobile push (#366): alerts to a paired phone, deduped + once each. This is the one thing that
    // still reaches OUT — to a person, not into a session.
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
