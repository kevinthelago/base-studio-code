// useFleetWakeBridge (#4101) — apply a `bsc fleet wake` request to the store and ACK it.
//
// WHY THIS EXISTS
// `bsc fleet list` (#4098) gave the director eyes on its workers; nothing gave it the one lever it
// actually needs — waking a parked one. A director that spots a stopped worker with open issues on its
// stream could only tell the user about it.
//
// THE ROUND TRIP
//   bsc fleet wake → request file → Rust watcher → `bsc://fleet-wake` → HERE → store → `fleet_wake_ack`
//
// The ack is load-bearing rather than ceremony: the wake KILLS the PTY before relaunching, so a wake
// that silently failed would leave a dead worker behind a caller that believes it is running. That is
// #4025 exactly. So this ALWAYS acks — success or a stated error.
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { log } from "@/shared/lib/core/log";
import { applyWake, type WakeRequest, type WakeAck } from "./fleetWakeBridge";

/**
 * Listen for `bsc://fleet-wake` and apply it. Mounted once by the shell.
 *
 * A thin adapter: the DECISION lives in `fleetWakeBridge.ts`, unit-testable without Tauri.
 */
export function useFleetWakeBridge(): void {
  useEffect(() => {
    let disposed = false;
    const un = listen<WakeRequest & { id: string }>("bsc://fleet-wake", (e) => {
      const { id, ...req } = e.payload;
      let ack: WakeAck;
      try {
        // Read the action off a LIVE getState, not a captured snapshot: zustand hands out a new object
        // per update, so a stale closure could call a wakePane bound to an older tab list.
        ack = applyWake(id, req, { wakePane: (p, t) => useAppStore.getState().wakePane(p, t) });
      } catch (err) {
        // A throw here would strand the Rust waiter until its timeout. State it instead.
        ack = { id, error: `fleet wake threw: ${err instanceof Error ? err.message : String(err)}`, woke: false };
        log.error(`fleet wake ${id} threw: ${String(err)}`);
      }
      void invoke("fleet_wake_ack", { ack: { ...ack, id } }).catch((e2) => {
        // Nothing left to do — the caller will time out. Log it so the cause isn't a mystery.
        log.error(`fleet_wake_ack failed for ${id}: ${String(e2)}`);
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
