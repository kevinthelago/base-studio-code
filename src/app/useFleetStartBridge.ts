// useFleetStartBridge (`headless-fleet-launch-a-director-cannot-start-its-own-fleet`) — apply a
// `bsc fleet start` request and ACK it.
//
// THE ROUND TRIP
//   bsc fleet start <key> → request file → Rust watcher (resolves the project, reads plan.db's fleet,
//   refuses a live fleet, materializes the hub, creates EVERY worktree fail-closed) →
//   `bsc://fleet-start` → HERE → fleetStartProject → `fleet_start_ack`
//
// A thin adapter: the DECISION lives in `fleetStartBridge.ts`, unit-testable without Tauri.
//
// THIS IS NOT AN INJECTION PATH, for the same reason the director bridge is not: each session's
// context arrives as its kickoff/scope doc on disk, written before the launch reads it. Nothing is
// typed into a running session.
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { log } from "@/shared/lib/core/log";
import { applyFleetStart, type StartRequest, type StartAck } from "@/app/fleetStartBridge";

/** Listen for `bsc://fleet-start` and launch it. Mounted once by the shell. */
export function useFleetStartBridge(): void {
  useEffect(() => {
    let disposed = false;
    const un = listen<StartRequest>("bsc://fleet-start", (e) => {
      const req = e.payload;
      let ack: StartAck;
      try {
        ack = applyFleetStart(req, {
          // Read off a LIVE getState, not a captured snapshot — zustand hands out a new object per
          // update, so a stale closure could launch against an older tab list.
          fleetStartProject: (name, fleet, key, paths) =>
            useAppStore.getState().fleetStartProject(name, fleet, key, paths),
        });
      } catch (err) {
        ack = {
          id: req.id,
          error: `fleet start threw: ${err instanceof Error ? err.message : String(err)}`,
          launched: false,
        };
        log.error(`fleet start ${req.id} threw: ${String(err)}`);
      }
      void invoke("fleet_start_ack", { ack: { ...ack, id: req.id } }).catch((e2) => {
        // Nothing left to do — the caller will time out. Log it so the cause isn't a mystery.
        log.error(`fleet_start_ack failed for ${req.id}: ${String(e2)}`);
      });
    });
    return () => {
      disposed = true;
      void un.then((f) => {
        if (disposed) f();
      });
    };
  }, []);
}
