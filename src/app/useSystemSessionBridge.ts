// useSystemSessionBridge (#architect-starts-and-stops-system-sessions) — apply a `bsc session
// start|stop` request to the store and ACK it.
//
// THE ROUND TRIP
//   bsc session start → request file → Rust watcher → `bsc://session-lifecycle` → HERE → store
//                     → `system_session_ack`
//
// A thin adapter: the DECISION lives in `systemSessionBridge.ts`, unit-testable without Tauri. Same
// shape as `useFleetWakeBridge`, deliberately — one more emit-and-ack verb on the one channel, not a
// second mechanism.
//
// THIS IS NOT AN INJECTION PATH. Nothing here writes text into a session: `openStudio` mounts a
// studio the user could have opened by clicking, and the started session keeps its own role gate.
// `injectCallers.test.ts` asserts `injectPrompt` has no callers, and this must never become one.
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import { log } from "@/shared/lib/core/log";
import { applyLifecycle, type LifecycleRequest, type LifecycleAck } from "./systemSessionBridge";

/**
 * Listen for `bsc://session-lifecycle` and apply it. Mounted once by the shell.
 */
export function useSystemSessionBridge(): void {
  useEffect(() => {
    let disposed = false;
    const un = listen<LifecycleRequest>("bsc://session-lifecycle", async (e) => {
      const req = e.payload;
      let ack: LifecycleAck;
      try {
        // Read off a LIVE getState, not a captured snapshot: zustand hands out a new object per
        // update, so a stale closure could decide against an older `wantedStudios`.
        const st = useAppStore.getState();
        ack = await applyLifecycle(req, {
          wantedStudios: st.wantedStudios,
          openStudio: (id) => useAppStore.getState().openStudio(id),
          closeStudio: (id) => useAppStore.getState().closeStudio(id),
          setPendingDirective: (id, d) => useAppStore.getState().setStudioPendingDirective(id, d),
          // Killing is explicit, exactly as the idle reaper does it: dropping the host claim only
          // unmounts the <TerminalView> — its cleanup deliberately leaves the backend session alive
          // so a console tab-switch reconnects rather than respawns.
          killPane: async (p) => { await safeInvoke("pty_kill", { paneId: p }, undefined); },
        });
      } catch (err) {
        // A throw here would strand the Rust waiter until its timeout. State it instead.
        ack = {
          id: req.id,
          error: `session lifecycle threw: ${err instanceof Error ? err.message : String(err)}`,
        };
        log.error(`session lifecycle ${req.id} threw: ${String(err)}`);
      }
      void invoke("system_session_ack", { ack: { ...ack, id: req.id } }).catch((e2) => {
        // Nothing left to do — the caller will time out. Log it so the cause isn't a mystery.
        log.error(`system_session_ack failed for ${req.id}: ${String(e2)}`);
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
