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
import { STUDIO_IDS, STUDIO_SESSIONS, type StudioId } from "./lib/studioSessions";

/** Idle grace before an unwatched studio session is reclaimed. */
export const STUDIO_IDLE_MS = 30 * 60 * 1000;
/** Recheck interval while a due-to-be-reaped session still has Claude working in it. */
export const STUDIO_BUSY_RECHECK_MS = 60 * 1000;

export function useStudioReaper(): void {
  const wantedStudios = useAppStore((s) => s.wantedStudios);
  const studioViewers = useAppStore((s) => s.studioViewers);
  // studio id → its armed reap timer. A ref (not state) so re-arming never re-renders; the effect below
  // reconciles it against the current wanted/viewer state on every change.
  const timers = useRef<Map<StudioId, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const armed = timers.current;
    for (const id of STUDIO_IDS) {
      const idle = wantedStudios.includes(id) && (studioViewers[id] ?? 0) === 0;
      const timer = armed.get(id);
      if (!idle) {
        // Watched again (or already reaped) → cancel. This is the "re-opening before expiry" path.
        if (timer) { clearTimeout(timer); armed.delete(id); }
        continue;
      }
      if (timer) continue; // already counting down — don't restart the clock on an unrelated change

      const fire = () => {
        const st = useAppStore.getState();
        // Re-read at expiry: the arm-time snapshot is up to 30 minutes stale.
        if (!st.wantedStudios.includes(id) || (st.studioViewers[id] ?? 0) > 0) { armed.delete(id); return; }
        if (st.paneClaudeActive[STUDIO_SESSIONS[id].paneId]) {
          armed.set(id, setTimeout(fire, STUDIO_BUSY_RECHECK_MS)); // busy → defer, never cut off a turn
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
      armed.set(id, setTimeout(fire, STUDIO_IDLE_MS));
    }
  }, [wantedStudios, studioViewers]);

  // Drop every pending timer when the host unmounts (app teardown / a test cleanup).
  useEffect(() => {
    const armed = timers.current;
    return () => { for (const t of armed.values()) clearTimeout(t); armed.clear(); };
  }, []);
}
