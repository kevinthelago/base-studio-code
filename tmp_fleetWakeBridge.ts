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

import type { WakeStream } from "@/store/types";

/** The wake request as it arrives from Rust (`bsc://fleet-wake`). */
export interface WakeRequest {
  paneId: string;
  /** Empty ⇒ use {@link DEFAULT_WAKE_PROMPT}. */
  prompt?: string;
  /** Carried for completeness; the BUSY refusal it governs is applied in Rust, before this is emitted. */
  force?: boolean;
  /**
   * The plan.db row for a pane that is NOT LIVE, with the absolute cwd Rust resolved
   * (`the-director-cannot-start-a-stream-that-never-launched`).
   *
   * Present only when Rust had a reason to look it up, so its ABSENCE is meaningful in both
   * directions: a live pane never needed one, and a not-live pane whose stream plan.db does not name
   * gets none — which is how `wakePane` still refuses an UNKNOWN stream while starting a merely
   * unlaunched one.
   */
  stream?: WakeStream;
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
  /** Why a refusal happened, for the caller. `undefined` when there is nothing specific to say.
   *
   *  `wakePane` answers a BOOLEAN, so a refusal reached the director as one sentence listing every
   *  condition it might have been: "it resolved to no open tab, or is disabled". That sentence is
   *  already on record as having "sent three rounds of debugging at the frontend for a repo that was
   *  simply not cloned" (`fleet/wake.rs`), and it did it again — a pane left disabled by an End
   *  session read as a missing tab, twice.
   *
   *  Rust returns `ack.error` verbatim when present, so naming the condition here is the whole fix. */
  refusalReason?: (paneId: string) => string | undefined;
  /** The real `wakePane`. Returns whether the wake actually landed. */
  wakePane: (paneId: string, prompt: string, stream?: WakeStream) => boolean;
  /** `pty_kill` for this pane. MUST run before {@link WakeDeps.wakePane} so the remount SPAWNS rather
   *  than reconnecting — see the header. A no-op when there is no PTY (a dormant/reaped pane), which is
   *  why it is safe to call unconditionally rather than probing liveness first: the probe would be a
   *  second source of truth about what is alive, and Rust already owns that answer. */
  killPane: (paneId: string) => Promise<void>;
  /** Why the LAUNCH would refuse this pane, asked before anything is destroyed — or `undefined` when
   *  it would be admitted.
   *
   *  Backed by `pty_launch_refusal`, which calls the very predicate `pty_create` applies, so the
   *  pre-check and the launch cannot drift apart. Optional so a caller that cannot ask behaves as it
   *  did before rather than refusing every wake. */
  launchRefusal?: (paneId: string) => Promise<string | undefined>;
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

  // REFUSE BEFORE DESTROYING. The kill below is deliberate and unconditional, and the verdict that
  // follows it answers only whether a tab and a grid seat could be resolved — so a pane the LAUNCH
  // will refuse was killed anyway, and reported as woken.
  //
  // MEASURED: four network-monitor worktrees had no `.claude/settings.json`, which makes `pty_create`
  // return an error rather than start an ungated director or worker. Every wake of those panes
  // destroyed a live session, got refused, and acked `woke: true`. The command's own help already
  // warned about the shape — "the wake path kills first, so a false success would leave a dead worker
  // behind a caller that believes it is running" — it just had no way to ask in advance.
  //
  // This asks the SAME predicate the launch will apply (`pty_launch_refusal` → `launch_gate_refusal`),
  // so the two cannot disagree. A pre-check that said "admitted" while the launch refused would put us
  // right back to killing a session that cannot come back.
  //
  // Absent dep ⇒ skipped, so a caller that cannot ask (or a test that does not care) behaves exactly
  // as before rather than refusing everything.
  const blocked = await deps.launchRefusal?.(paneId).catch(() => undefined);
  if (blocked) return { id, woke: false, error: blocked };

  // A kill failure must not abort the wake: the common reason is that there was nothing to kill, and
  // refusing to wake a dormant pane because its absent PTY could not be killed would break the case
  // this command was built for.
  await deps.killPane(paneId).catch(() => {});
  // `req.stream` rides straight through: the store cannot read plan.db, so a stream it has never
  // seen is only startable because Rust resolved the row and sent it. Undefined is the ordinary
  // wake, and leaves the historical refusal exactly where it was.
  const woke = deps.wakePane(paneId, req.prompt?.trim() || DEFAULT_WAKE_PROMPT, req.stream);
  if (!woke) {
    // Name the condition when we can. Rust falls back to its own generic sentence when we cannot.
    return { id, woke, error: deps.refusalReason?.(paneId) };
  }
  return { id, woke };
}
