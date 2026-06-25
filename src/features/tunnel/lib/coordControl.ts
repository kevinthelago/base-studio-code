// Mobile → desktop coordination control (#935). The phone can ask the desktop to WAKE a
// parked worker (its blocking dependency landed) or APPROVE a worker paused for the user
// (a checkpoint / push-confirm gate). Both arrive as Tauri events the desktop already
// decodes from the tunnel (`tunnel://coord-wake` / `tunnel://coord-approve`, src-tauri/
// src/tunnel.rs); this module decides — purely, from the coordination state — how to
// honor one. Launching the fleet is deliberately NOT reachable from the phone.

import {
  wakePromptFor,
  waitingWakePrompt,
  type CoordState,
  type Waiter,
} from "@/shared/lib/fleet/coordination";

export type CoordControlKind = "wake" | "approve";

export interface MobileResume {
  session: string;
  /** The wake/resume prompt delivered to the session. */
  prompt: string;
  /**
   * How to deliver it:
   *  - "fresh"  → relaunch the parked pane (a dependency waiter; matches the inbox Wake).
   *  - "inject" → deliver into the live, paused pane (a user-paused gate; keeps context).
   */
  via: "fresh" | "inject";
}

/**
 * Decide how to honor a mobile coordination request for `session`, given the current
 * coordination state and the set of dependency waiters whose deps have landed (`ready`).
 *
 * Returns `null` when the session isn't in a state that request can resolve — we never
 * wake or approve an arbitrary session a phone names, only one the coordination log shows
 * actually parked. So:
 *  - `approve` resolves ONLY a session paused for the user (`state.waiting`).
 *  - `wake` resolves a ready dependency waiter, and also a user-paused session (a phone
 *    "wake" on a paused gate is a reasonable resume), never an unknown session.
 */
export function planMobileResume(
  kind: CoordControlKind,
  session: string,
  state: CoordState,
  ready: Waiter[],
): MobileResume | null {
  const paused = state.waiting.find((w) => w.session === session);

  if (kind === "approve") {
    return paused ? { session, prompt: waitingWakePrompt(paused), via: "inject" } : null;
  }

  // kind === "wake"
  const readyWaiter = ready.find((w) => w.session === session);
  if (readyWaiter) return { session, prompt: wakePromptFor(readyWaiter, state), via: "fresh" };
  if (paused) return { session, prompt: waitingWakePrompt(paused), via: "inject" };
  return null;
}
