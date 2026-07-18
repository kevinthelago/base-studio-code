// useStudioReaper (#3357) — the idle reaper for the app-owned studio sessions.
//
// A studio session deliberately OUTLIVES the surface that opened it: leaving the Design Studio page keeps
// the designer warm on TerminalHost so the Glance node can still morph into it. Something has to reclaim
// it eventually, or every studio ever opened runs a Claude process until the app quits.
//
// The rule: while a studio is wanted but NO surface is showing it (viewer count 0), a 30-minute timer runs.
// On expiry the session is killed and the studio leaves the wanted list, so its persistent mount unmounts
// with it. Anything that shows it again before expiry cancels the timer, and because the pane id is stable
// a later re-open resumes the same conversation (`claude --continue`) either way.
//
// NOTE: dropping the last TerminalHost claim is NOT itself a teardown — `TerminalView`'s cleanup keeps the
// backend PTY alive on purpose (a console tab-switch must reconnect, not respawn). So the reaper issues the
// `pty_kill` explicitly; the unmount only reclaims the xterm.
//
// ONE exception, checked at expiry rather than at arm time: if Claude is actively running in the session
// (`paneClaudeActive`), killing it would cut off work in flight. The reaper then RE-ARMS on a short recheck
// instead of reaping, so a busy session is deferred (indefinitely, while it stays busy) and reclaimed as
// soon as it goes quiet.
import { useEffect, useRef } from "react";
import { useAppStore } from "@/store";
import { fireInvoke } from "@/shared/lib/core/safeInvoke";
// The reaping policy is ONE user-facing setting (Settings → Planner → "Reap idle background sessions"),
// so the studio threshold lives alongside the console pane thresholds in `ReaperConfig` rather than in a
// second config the user would have to find separately. Pure leaf import, like `detachWindow` above.
import { DEFAULT_STUDIO_IDLE_MS, studioIdleMs } from "@/app/console/lib/idleReaper";
import { STUDIO_IDS, STUDIO_SESSIONS, type StudioId } from "./lib/studioSessions";

/** Default idle grace before an unwatched studio session is reclaimed. The EFFECTIVE value is the
 *  user's `idleReaper.studioIdleMs` setting; this is the packaged default (and the test baseline). */
export const STUDIO_IDLE_MS = DEFAULT_STUDIO_IDLE_MS;
/** Recheck interval while a due-to-be-reaped session still has Claude working in it. */
export const STUDIO_BUSY_RECHECK_MS = 60 * 1000;

export function useStudioReaper(): void {
  const wantedStudios = useAppStore((s) => s.wantedStudios);
  const studioViewers = useAppStore((s) => s.studioViewers);
  // The user's reaping policy (Settings → Planner). `enabled` is the master switch for ALL idle
  // reaping, so turning it off keeps studio sessions warm indefinitely too — one predictable rule.
  const reaperCfg = useAppStore((s) => s.idleReaper);
  const idleMs = studioIdleMs(reaperCfg);
  const enabled = reaperCfg.enabled;
  // studio id → its armed reap timer + the duration it was armed with. A ref (not state) so re-arming
  // never re-renders; the effect below reconciles it against the current wanted/viewer/config state.
  // The duration is tracked so a settings change re-arms rather than silently keeping the old clock.
  const timers = useRef<Map<StudioId, { t: ReturnType<typeof setTimeout>; ms: number; busy?: boolean }>>(new Map());

  useEffect(() => {
    const armed = timers.current;
    for (const id of STUDIO_IDS) {
      const idle = enabled && wantedStudios.includes(id) && (studioViewers[id] ?? 0) === 0;
      const timer = armed.get(id);
      if (!idle) {
        // Watched again, already reaped, or reaping switched off → cancel. This is the
        // "re-opening before expiry" path (and the master-switch-off path).
        if (timer) { clearTimeout(timer.t); armed.delete(id); }
        continue;
      }
      // Already counting down at the CURRENT threshold → leave it alone; an unrelated change (another
      // studio's churn) must not restart this clock. A changed threshold DOES re-arm, so editing the
      // setting takes effect immediately rather than only on the next idle transition. A BUSY deferral
      // is left alone either way: it is on the short recheck loop and re-evaluates itself, so treating
      // its recheck interval as a "changed threshold" would reset a working session to a full idle wait.
      if (timer && (timer.busy || timer.ms === idleMs)) continue;
      if (timer) { clearTimeout(timer.t); armed.delete(id); }

      const fire = () => {
        const st = useAppStore.getState();
        // Re-read at expiry: the arm-time snapshot is as stale as the configured threshold (30 min by
        // default, and the user can set it much longer).
        if (!st.wantedStudios.includes(id) || (st.studioViewers[id] ?? 0) > 0) { armed.delete(id); return; }
        if (!st.idleReaper.enabled) { armed.delete(id); return; } // switched off while counting down
        if (st.paneClaudeActive[STUDIO_SESSIONS[id].paneId]) {
          // Busy → defer, never cut off a turn. Re-armed at the RECHECK interval, so `ms` records that
          // (a settings change during a deferral re-arms it at the new threshold on the next reconcile).
          armed.set(id, { t: setTimeout(fire, STUDIO_BUSY_RECHECK_MS), ms: STUDIO_BUSY_RECHECK_MS, busy: true });
          return;
        }
        armed.delete(id);
        // Kill the PTY EXPLICITLY. Dropping the last TerminalHost claim only unmounts the <TerminalView>
        // (its cleanup deliberately leaves the backend session alive so a console tab-switch reconnects
        // rather than respawns) — so without this the xterm would go away while the `claude` process kept
        // running forever. Killing first, then dropping the mount, means the reclaim is complete.
        fireInvoke("pty_kill", { paneId: STUDIO_SESSIONS[id].paneId }, console.error);
        st.closeStudio(id);
      };
      armed.set(id, { t: setTimeout(fire, idleMs), ms: idleMs });
    }
  }, [wantedStudios, studioViewers, idleMs, enabled]);

  // Drop every pending timer when the host unmounts (app teardown / a test cleanup).
  useEffect(() => {
    const armed = timers.current;
    return () => { for (const { t } of armed.values()) clearTimeout(t); armed.clear(); };
  }, []);
}
