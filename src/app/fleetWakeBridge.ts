// fleetWakeBridge (#4101) — decide what a `bsc fleet wake` request does to the store.
//
// Pure on purpose: the DECISION (refuse a busy pane, pick the prompt, report what happened) is testable
// without Tauri or a rendered app, and the listener stays a thin adapter — the same split
// `navigateBridge` uses.
//
// WHY THE VERDICT MATTERS
// `wakePane` KILLS the PTY before relaunching. It returns false when it cannot resolve the pane's owning
// tab, or when the pane is disabled — and a false reported as success leaves a dead worker behind a
// caller that believes it is running. That is #4025 exactly: `wakePane` resolved tabs by the retired
// positional pane id, returned false for all 273 real sessions, and the Wake button killed every parked
// worker silently. So the verdict is carried all the way back to the CLI.

/** The wake request as it arrives from Rust (`bsc://fleet-wake`). */
export interface WakeRequest {
  paneId: string;
  /** Empty ⇒ use {@link DEFAULT_WAKE_PROMPT}. */
  prompt?: string;
  /** Carried for completeness; the BUSY refusal it governs is applied in Rust, before this is emitted. */
  force?: boolean;
}

/** What we send back via `fleet_wake_ack`. */
export interface WakeAck {
  id: string;
  error?: string;
  woke: boolean;
}

/**
 * The wake text a director gets when it does not supply one.
 *
 * Deliberately a CHANGE-REQUEST framing rather than a bare "continue": a woken worker is being brought
 * back because something needs doing, and an empty prompt would drop it at a prompt with no task — the
 * failure mode maintenance mode (#1957) exists to avoid.
 */
export const DEFAULT_WAKE_PROMPT =
  "You have been woken by the director because there is a change request for your stream. " +
  "Re-read your assignment, check `bsc plan issue list` for what is open on it, and continue.";

/**
 * The store surface this needs — narrowed so the pure fn stays decoupled from the slice.
 *
 * Note there is no busy check: BUSY is resolved in Rust before the request is ever emitted, since the
 * store cannot see whether a shell has a live descendant.
 */
export interface WakeDeps {
  /** The real `wakePane`. Returns whether the wake actually landed. */
  wakePane: (paneId: string, prompt: string) => boolean;
}

/**
 * Apply one wake request. Never throws — every path produces an ack, because silence would strand the
 * Rust waiter until its timeout and surface as "the frontend did not apply the wake", sending someone
 * to debug the wrong thing.
 */
export function applyWake(id: string, req: WakeRequest, deps: WakeDeps): WakeAck {
  const paneId = (req.paneId ?? "").trim();
  if (!paneId) return { id, error: "fleet wake: no pane id", woke: false };

  const woke = deps.wakePane(paneId, req.prompt?.trim() || DEFAULT_WAKE_PROMPT);
  return { id, woke };
}
