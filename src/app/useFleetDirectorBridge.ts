// useFleetDirectorBridge (#architect-creates-a-director-with-discovery) — apply a
// `bsc fleet director new` request and ACK it.
//
// THE ROUND TRIP
//   bsc fleet director new <key> → request file → Rust watcher (resolves the project, refuses a live
//   director, seeds prompts/director-kickoff.md) → `bsc://fleet-director` → HERE → fleetStartProject
//   → `fleet_director_ack`
//
// A thin adapter: the DECISION lives in `fleetDirectorBridge.ts`, unit-testable without Tauri.
//
// THIS IS NOT AN INJECTION PATH. The director's context arrives as its KICKOFF DOC, written to the hub
// before the launch reads it — the same way every fleet director has always received one. Nothing is
// typed into a running session, and `injectCallers.test.ts` stays green on its empty set.
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { log } from "@/shared/lib/core/log";
import { applyDirectorNew, type DirectorRequest, type DirectorAck } from "./fleetDirectorBridge";

/** Listen for `bsc://fleet-director` and launch it. Mounted once by the shell. */
export function useFleetDirectorBridge(): void {
  useEffect(() => {
    let disposed = false;
    const un = listen<DirectorRequest>("bsc://fleet-director", (e) => {
      const req = e.payload;
      let ack: DirectorAck;
      try {
        ack = applyDirectorNew(req, {
          // Read off a LIVE getState, not a captured snapshot — zustand hands out a new object per
          // update, so a stale closure could launch against an older tab list.
          fleetStartProject: (name, fleet, key, paths) =>
            useAppStore.getState().fleetStartProject(name, fleet, key, paths),
        });
      } catch (err) {
        ack = {
          id: req.id,
          error: `fleet director threw: ${err instanceof Error ? err.message : String(err)}`,
          created: false,
        };
        log.error(`fleet director ${req.id} threw: ${String(err)}`);
      }
      void invoke("fleet_director_ack", { ack: { ...ack, id: req.id } }).catch((e2) => {
        // Nothing left to do — the caller will time out. Log it so the cause isn't a mystery.
        log.error(`fleet_director_ack failed for ${req.id}: ${String(e2)}`);
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
