// The always-on warden (#1102): periodically checks every live WORKER against its trusted plan
// anchor and, on a deterministic trip (out-of-lane edit / gate-denied command — possible prompt
// injection or hijack), HARD-PAUSES it: kills the PTY, marks it quarantined, and fires a mobile
// push so the user is alerted even off the desktop. Asymmetric by design — the watcher (this app
// loop) reads only structured, trusted telemetry (the plan, the git diff, the bsc-audit log),
// never the issue/PR/web prose a worker ingests, so it can't itself be steered by an injection.
//
// Mount once at the app root (App.tsx) so it runs regardless of the active screen — a hijack must
// be caught while the user is anywhere. Mirrors useCoordinator's loop shape.

import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store";
import { roleCapability } from "../session/sessionRoles";
import { planWarden, parseAuditCommands, type WardenSession } from "./warden";
import { log } from "../core/log";

const POLL_MS = 6000; // heavier than the coord loop (reads a git diff per worker) — every ~6s

/** Gather one live worker's trusted activity + anchor, or null if it can't be evaluated. */
async function buildSession(paneId: string): Promise<WardenSession | null> {
  const st = useAppStore.getState();
  const stream = st.fleetPaneStreams[paneId];
  if (!stream) return null;
  const role = st.paneRoles[paneId] ?? "worker";
  if (role !== "worker") return null; // the warden watches workers — the exposed attack surface
  const cwd = st.paneCwds[paneId];
  if (!cwd) return null;

  const changedFiles = await invoke<string[]>("read_worktree_changes", { cwd }).catch(() => [] as string[]);
  const auditLines = await invoke<string[]>("read_audit_log", { limit: 500 }).catch(() => [] as string[]);
  return {
    paneId,
    anchor: {
      streamId: stream.id,
      ownedGlobs: stream.owns,
      capability: roleCapability(role, { writeGlobs: stream.owns }),
      flow: stream.flow,
    },
    activity: { changedFiles: changedFiles ?? [], commands: parseAuditCommands(auditLines ?? [], paneId) },
  };
}

export function useWarden(): void {
  // Panes a quarantine is mid-actuation for, so a slow kill+push doesn't double-fire next tick.
  const inFlight = useRef<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      const st = useAppStore.getState();
      const panes = Object.keys(st.fleetPaneStreams);
      if (panes.length === 0) return;

      const quarantined = new Set([...Object.keys(st.quarantinedPanes), ...inFlight.current]);
      const sessions = (await Promise.all(panes.map(buildSession))).filter((s): s is WardenSession => s !== null);
      if (cancelled) return;

      for (const trip of planWarden(sessions, quarantined)) {
        if (inFlight.current.has(trip.paneId)) continue;
        inFlight.current.add(trip.paneId);
        // HARD auto-pause: kill the PTY first (a hijacked session can't be trusted to stop
        // itself), then record + alert. Order matters — stop the blast radius before anything else.
        void (async () => {
          try {
            await invoke("pty_kill", { paneId: trip.paneId }).catch((e) =>
              log.error(`warden: pty_kill ${trip.paneId} failed: ${e}`));
            useAppStore.getState().markQuarantine(trip.paneId, {
              streamId: trip.streamId,
              summary: trip.summary,
              at: Date.now(),
            });
            // Mobile alert (#1102 slice 2a): a "quarantine" coord event → FCM push to paired phones.
            await invoke("tunnel_emit_coord_event", {
              kind: "quarantine",
              session: trip.paneId,
              refKey: trip.summary,
              at: Date.now(),
            }).catch((e) => log.error(`warden: quarantine push ${trip.paneId} failed: ${e}`));
            log.warn(`warden: quarantined ${trip.paneId} (${trip.streamId}) — ${trip.summary}`);
          } finally {
            inFlight.current.delete(trip.paneId);
          }
        })();
      }
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
}
