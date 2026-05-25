/**
 * Serializes `claude` cold-starts so they don't stampede the shared OAuth
 * credential store.
 *
 * Why: every console launches the `claude` CLI, which on startup reads (and, if
 * the access token is near expiry, refreshes) credentials in the user's home.
 * The OAuth refresh token is single-use and, on Windows, the credentials file is
 * subject to mandatory locking. When a triage/project tab opens it mounts N panes
 * at once, firing N `claude` processes within milliseconds — they race on the
 * same credentials, one wins the refresh, the rest read an invalidated token,
 * fail, and clear the shared store. The visible symptom is *every* session (and
 * any prior login) being asked to log in again. Launching them one at a time,
 * spaced far enough apart for each to finish authenticating, avoids the race.
 *
 * An API key would sidestep this entirely (no refresh dance), but subscription
 * (OAuth) auth is the only option here.
 *
 * NOTE: the inter-launch gap is currently 0 — cold-starts are still serialized
 * (one per tick, strictly ordered via the chain below) but no longer spaced by a
 * wall-clock wait. If multi-pane opens start logging sessions out again, raise
 * {@link CLAUDE_LAUNCH_GAP_MS} to re-introduce spacing.
 */

/** Milliseconds between consecutive `claude` cold-starts.
 *
 *  0 = no wall-clock spacing; launches stay serialized but ramp as fast as the
 *  event loop allows. Raise this (e.g. 2000) if sessions get logged out on
 *  multi-pane opens, which means the OAuth credential race has resurfaced. */
export const CLAUDE_LAUNCH_GAP_MS = 0;

/** Tail of the launch queue — each new cold-start chains after this. */
let chain: Promise<void> = Promise.resolve();
/** Pane ids that have already cold-started, so tab-switch reconnects skip the gate. */
const launched = new Set<string>();

/**
 * Gate a `claude` cold-start for `key` (a pane id).
 *
 * The first launch resolves immediately; each subsequent *new* launch resolves
 * one `gapMs` after the previous, so launches happen strictly one-at-a-time and
 * spaced out. A `key` that has already launched once resolves immediately and is
 * not re-queued — tab-switch remounts (which reconnect rather than re-spawn) are
 * never delayed.
 *
 * @param key  pane id identifying the session (e.g. `t1p0`)
 * @param gapMs spacing to enforce after this launch (defaults to {@link CLAUDE_LAUNCH_GAP_MS})
 * @returns a promise that resolves when it is this launch's turn to start
 */
export function gateClaudeLaunch(key: string, gapMs: number = CLAUDE_LAUNCH_GAP_MS): Promise<void> {
  if (launched.has(key)) return Promise.resolve();
  launched.add(key);
  const myTurn = chain;
  chain = myTurn.then(() => new Promise<void>((resolve) => setTimeout(resolve, gapMs)));
  return myTurn;
}

/**
 * Forget that `key` has launched, so its next cold-start is gated again. Call
 * this when a session is killed (e.g. console disabled) so a later batch
 * re-enable doesn't bypass the gate.
 */
export function resetLaunchGate(key: string): void {
  launched.delete(key);
}

/** Test-only: clear all gate state. */
export function __resetLaunchGateForTest(): void {
  chain = Promise.resolve();
  launched.clear();
}
