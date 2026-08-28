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
// The ack is load-bearing rather than ceremony: the wake KILLS the PTY before relaunching (see
// `applyWake`), so a wake that silently failed would leave a dead worker behind a caller that believes
// it is running. That is #4025 exactly. So this ALWAYS acks — success or a stated error.
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { findPaneOwnerTab } from "@/app/console/lib/paneIdentity";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import { log } from "@/shared/lib/core/log";
import { applyWake, type WakeRequest, type WakeAck } from "@/app/fleetWakeBridge";

/**
 * Listen for `bsc://fleet-wake` and apply it. Mounted once by the shell.
 *
 * A thin adapter: the DECISION lives in `fleetWakeBridge.ts`, unit-testable without Tauri.
 */
export function useFleetWakeBridge(): void {
  useEffect(() => {
    let disposed = false;
    const un = listen<WakeRequest & { id: string }>("bsc://fleet-wake", async (e) => {
      const { id, ...req } = e.payload;
      let ack: WakeAck;
      try {
        // Read the action off a LIVE getState, not a captured snapshot: zustand hands out a new object
        // per update, so a stale closure could call a wakePane bound to an older tab list.
        ack = await applyWake(id, req, {
          // EVERY argument, forwarded. This arrow used to take `(p, t)` and drop the third — the plan
          // row Rust resolves for a stream that has never launched
          // (#the-wake-adapter-drops-the-stream-it-was-handed). The failure was invisible twice over:
          // TypeScript accepts a 2-arg function where a 3-arg type is wanted (sound, and deliberate),
          // and both sides of this seam were tested — the bridge against a MOCK wakePane, the store by
          // calling wakePane directly — so the only untested thing was the join, which is where the
          // value went. The result was indistinguishable from the bug the row exists to fix: the store
          // saw no stream and refused with "resolved to no open tab".
          wakePane: (p, t, s) => useAppStore.getState().wakePane(p, t, s),
      // The store is the only place that knows WHICH condition refused, and each has a different fix.
      refusalReason: (paneId) => {
        const s = useAppStore.getState();
        if (!findPaneOwnerTab(s.tabs, paneId)) {
          return (
            `fleet wake: '${paneId}' belongs to no open tab, so there is nowhere to bring it back. ` +
            `Relaunch the project's fleet rather than waking this one pane.`
          );
        }
        if (!s.fleetPaneStreams[paneId]) {
          return (
            `fleet wake: '${paneId}' has no stream in the roster and plan.db did not name one either, ` +
            `so the app cannot tell what to start. Check \`bsc plan fleet get\` for this project.`
          );
        }
        return undefined;
      },
          // Kill before the bump so the remount spawns instead of reconnecting to a live shell whose
          // agent has exited — the same order `actuateWake` uses. `fireInvoke` swallows the "no such
          // session" case, which is the normal one for an already-reaped pane.
          killPane: async (p) => { await safeInvoke("pty_kill", { paneId: p }, undefined); },
          // Ask whether the LAUNCH would refuse this pane, before the kill above destroys anything.
          // `pty_launch_refusal` calls the same predicate `pty_create` applies, so the answer here and
          // the answer at launch cannot drift. The cwd is the store's — the backend has no per-pane
          // cwd for a live pane, which is why the question is asked from this side.
          //
          // `safeInvoke`'s fallback is `undefined` = "admitted", so a missing command or a backend
          // mid-restart leaves the wake behaving exactly as it did before rather than refusing
          // everything: this guards against killing a pane we KNOW cannot relaunch, not against
          // every uncertainty.
          launchRefusal: async (p) => await safeInvoke<string | null>(
            "pty_launch_refusal",
            { paneId: p, cwd: useAppStore.getState().paneCwds[p] ?? "" },
            null,
          ) ?? undefined,
        });
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
