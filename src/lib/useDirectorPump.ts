// The director pump (#366): drives the fleet's async-integrator "director" session so it
// does not just idle after its kickoff. Polls the coordination log and, per launched
// director pane, asks decideDirectorAction whether to re-prompt it (event-driven on new
// worker activity, or on a heartbeat) -- then injects that prompt into the pane via
// pty_write while it is idle. The director acts (review/merge PRs, bsc-merged/bsc-closed),
// which the existing useCoordinator turns into worker wake-ups. Mounted once in
// ConsoleScreen (which stays mounted across screens). Pure decision logic lives in
// directorDrive.ts; this is the thin Tauri/React actuator.
import { useEffect, useRef, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import {
  decideDirectorAction, resolveDirectorDrive,
  DEFAULT_HEARTBEAT_MS, INJECT_COOLDOWN_MS,
} from "../screens/projects/directorDrive";

const POLL_MS = 3000;

interface PaneCursor { cursor: number; lastInjectAt: number; }

/**
 * @param paneStatusesRef live per-pane Claude status ("idle" = safe to inject). Owned by
 *        ConsoleScreen; read each tick so we never interrupt a director mid-turn.
 */
export function useDirectorPump(paneStatusesRef: RefObject<Record<string, "run" | "on" | "idle">>): void {
  const cursors = useRef<Map<string, PaneCursor>>(new Map());
  const inFlight = useRef<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      const drives = useAppStore.getState().paneDirectorDrive;
      const paneIds = Object.keys(drives);
      if (paneIds.length === 0) return;
      const lines = await invoke<string[]>("read_coord_log", { limit: 2000 }).catch(() => null);
      if (cancelled || !lines) return;
      const now = Date.now();
      const statuses = paneStatusesRef.current ?? {};
      for (const paneId of paneIds) {
        if (inFlight.current.has(paneId)) continue;
        // First sight of a director pane: start its cursor at the current log end so we act
        // only on activity AFTER it launched, and stamp lastInjectAt=now so the heartbeat
        // waits a full interval rather than firing immediately.
        let prev = cursors.current.get(paneId);
        if (!prev) { prev = { cursor: lines.length, lastInjectAt: now }; cursors.current.set(paneId, prev); }
        const res = decideDirectorAction({
          lines,
          cursor: prev.cursor,
          drive: resolveDirectorDrive(drives[paneId]),
          idle: statuses[paneId] === "idle",
          now,
          lastInjectAt: prev.lastInjectAt,
          heartbeatMs: DEFAULT_HEARTBEAT_MS,
          cooldownMs: INJECT_COOLDOWN_MS,
        });
        cursors.current.set(paneId, { cursor: res.cursor, lastInjectAt: res.lastInjectAt });
        if (res.inject) {
          inFlight.current.add(paneId);
          void invoke("pty_write", { paneId, data: res.inject + "\r" })
            .catch(() => {})
            .finally(() => inFlight.current.delete(paneId));
        }
      }
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [paneStatusesRef]);
}
