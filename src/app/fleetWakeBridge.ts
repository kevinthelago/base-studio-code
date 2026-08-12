// fleetWakeBridge (#4101) — decide what a `bsc fleet wake` request does to the store.
//
// Pure on purpose: the DECISION (refuse a busy pane, pick the prompt, report what happened) is testable
// without Tauri or a rendered app, and the listener stays a thin adapter — the same split
// `navigateBridge` uses.
//
// WHY THE VERDICT MATTERS
// `wakePane` returns false when it cannot resolve the pane's owning tab, or when the pane is disabled —
// and a false reported as success leaves a dead worker behind a caller that believes it is running. That
// is #4025 exactly: `wakePane` resolved tabs by the retired positional pane id, returned false for all
// 273 real sessions, and the Wake button killed every parked worker silently. So the verdict is carried
// all the way back to the CLI.
//
// WHY THE KILL IS HERE AND NOT ONLY IN `wakePane`
// `wakePane` does NOT kill anything — it bakes the startup prompt and bumps the owning tab's `runId`.
// (A comment here used to claim otherwise, which is very likely why this path never killed: it read as
// already handled.) The bump remounts the pane, and `pty_create` "returns true for a new session, FALSE
// when reconnecting to an existing one" (TerminalView) — on reconnect it just sends `\n` and the baked
// prompt is discarded (the #3998 init_cmd-on-reconnect trap).
//
// So for a pane whose SHELL OUTLIVED ITS AGENT — bash alive, Claude exited, which `bsc fleet list`
// reports as `live && !busy` — the wake reconnected to bash, never started Claude, and still returned
// `woke: true`. Worse than a refusal: the director was told it landed. The coordinator's `actuateWake`
// already got this right ("Kill first so the runId-bump remount spawns a FRESH session (not a
// reconnect)"); this path was missing exactly that step, and the two differed by one line for no reason
// anyone recorded.

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
  /** `pty_kill` for this pane. MUST run before {@link WakeDeps.wakePane} so the remount SPAWNS rather
   *  than reconnecting — see the header. A no-op when there is no PTY (a dormant/reaped pane), which is
   *  why it is safe to call unconditionally rather than probing liveness first: the probe would be a
   *  second source of truth about what is alive, and Rust already owns that answer. */
  killPane: (paneId: string) => Promise<void>;
}

/**
 * Apply one wake request. Never throws — every path produces an ack, because silence would strand the
 * Rust waiter until its timeout and surface as "the frontend did not apply the wake", sending someone
 * to debug the wrong thing.
 *
 * ORDER IS LOAD-BEARING: kill, then wake. Reversed, the remount races the kill and can reconnect to a
 * PTY that is about to die; skipped, a live shell is reconnected and the prompt is silently dropped.
 */
export async function applyWake(id: string, req: WakeRequest, deps: WakeDeps): Promise<WakeAck> {
  const paneId = (req.paneId ?? "").trim();
  if (!paneId) return { id, error: "fleet wake: no pane id", woke: false };

  // A kill failure must not abort the wake: the common reason is that there was nothing to kill, and
  // refusing to wake a dormant pane because its absent PTY could not be killed would break the case
  // this command was built for.
  await deps.killPane(paneId).catch(() => {});
  const woke = deps.wakePane(paneId, req.prompt?.trim() || DEFAULT_WAKE_PROMPT);
  return { id, woke };
}
