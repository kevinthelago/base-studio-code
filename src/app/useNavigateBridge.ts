// useNavigateBridge (#3274, epic #3260) — apply a `bsc navigate` request to the store and ACK it.
//
// WHY THIS EXISTS
// `bsc shot` (#3261) gave bsc eyes; nothing gave it hands. The Design Studio's selection was local React
// state, so nothing outside the UI could select a component and an external session could only photograph
// whatever happened to be on screen. For the overnight loop (#3263) that is disqualifying: it needs
// "component X in theme Y", and without steering it would iterate on stale frames while every log line
// looked reasonable.
//
// THE ROUND TRIP
//   bsc navigate → request file → Rust watcher → `bsc://navigate` → HERE → store → `navigate_ack` → reply
//
// The ack is the point: it makes `bsc navigate … && bsc shot take` race-free rather than hoping the view
// landed first. So this ALWAYS acks — success or a stated error. Silence would strand the Rust waiter
// until its timeout and surface as "the frontend did not apply the navigation", sending someone to debug
// the wrong thing.
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { WORKSPACES, type Workspace } from "@/app/registry";
import { PROJECT_MODES } from "@/features/planner";
import { log } from "@/shared/lib/core/log";
import { applyNavigate, type NavRequest, type NavAck } from "./navigateBridge";
import { installHumanPresence, humanPresent } from "./humanPresence";

/**
 * Listen for `bsc://navigate` and apply it. Mounted once by the shell.
 *
 * Kept as a thin adapter: the DECISION (what a request resolves to, what errors) is pure and lives in
 * `navigateBridge.ts`, so it is unit-testable without Tauri or a rendered app.
 */
export function useNavigateBridge(): void {
  // #4248: the presence listeners live with the bridge that consults them, so a build cannot ship the
  // gate without the signal that feeds it (an always-absent human = the pre-#4248 behaviour, silently).
  useEffect(() => installHumanPresence(), []);

  useEffect(() => {
    let disposed = false;
    const un = listen<NavRequest & { id: string }>("bsc://navigate", (e) => {
      const { id, ...req } = e.payload;
      let ack: NavAck;
      try {
        ack = applyNavigate(req, {
          // A LIVE getter, not `getState()` once: zustand hands out a new object per update, so a
          // captured snapshot would make the ack report the PRE-navigation view — a confident lie.
          read: () => useAppStore.getState(),
          workspaces: WORKSPACES.map((w) => w.key as Workspace),
          pages: PROJECT_MODES.map((p: { id: string }) => p.id),
          humanPresent,
        });
      } catch (err) {
        // A throw here would silently strand the Rust waiter. Turn it into a stated error instead.
        ack = { id, error: `navigate threw: ${err instanceof Error ? err.message : String(err)}` };
        log.error(`navigate ${id} threw: ${String(err)}`);
      }
      void invoke("navigate_ack", { ack: { ...ack, id } }).catch((e2) => {
        // Nothing left to do — the caller will time out. Log it so the cause isn't a mystery.
        log.error(`navigate_ack failed for ${id}: ${String(e2)}`);
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
