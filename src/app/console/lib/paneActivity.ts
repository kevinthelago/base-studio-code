// Per-pane turn-activity gating for the console status dot (#1184).
//
// The status dot's only per-turn signal is a 1.5s silence timer (`QUIET_MS` in TerminalView),
// which can't tell "done" from "working but silent" — so a worker that's thinking, running a long
// silent tool call, or backing off false-idles mid-turn. The fix drives authoritative turn
// boundaries from Claude Code hooks: `bsc-activity run` on UserPromptSubmit (a turn opens) and
// `bsc-activity idle` on Stop/SubagentStop (the turn closes), recorded to `activity.log`.
// `bsc logs pane-activity` (over the `bsc` bridge, #2144) returns the latest state per pane;
// TerminalView polls it and uses the pure helpers here to decide whether a pane's turn is still open.
//
// ADDITIVE / SAFE: the gate only PREVENTS a wrongful idle — a pane whose turn is still open is kept
// "run" past the silence timeout. It never forces idle on its own; a pane still goes idle on the
// authoritative Stop (which records `idle`, closing the turn) or, for non-bash / never-launched
// panes that emit no activity at all, on the silence timer exactly as before (no regression).

/** One pane's latest turn-boundary state, as serialized by `bsc logs pane-activity`
 *  (`logs::PaneActivity` — plain snake_case, no serde rename, so the keys match the struct). */
export interface PaneActivity {
  pane: string;
  /** `"run"` — a turn is open (the agent is working); `"idle"` — the turn closed at a Stop;
   *  `"attn"` (#4005) — Claude Code fired `Notification`, i.e. it is STOPPED waiting on the user
   *  (a permission prompt, or a long input idle). */
  state: "run" | "idle" | "attn";
  /** Epoch-ms timestamp of the event. */
  at: number;
}

/**
 * Whether this pane's turn is still OPEN — i.e. the silence timer must NOT idle it.
 *
 * True only when the latest recorded activity is a `run` (UserPromptSubmit with no following Stop).
 * `undefined` (no activity recorded — a non-bash session, or a pane that hasn't taken a turn yet)
 * is NOT a turn-open signal, so the silence timer stays authoritative and behavior is unchanged.
 */
export function isTurnOpen(activity: PaneActivity | undefined): boolean {
  return activity?.state === "run";
}

/**
 * Is this pane STOPPED waiting on the user (#4005)?
 *
 * Distinct from idle in the way that matters: an idle pane is finished, an `attn` pane is blocked and
 * will stay blocked until a person acts. That is the most actionable state in the cockpit and, before
 * this, the least visible one — a pane awaiting a permission prompt looked exactly like a quiet one.
 *
 * Deliberately NOT turn-open ({@link isTurnOpen} stays false): the agent is not working, so the
 * silence timer should be free to settle the status dot as it always has. This adds a signal; it does
 * not re-gate the existing one.
 */
export function needsAttention(activity: PaneActivity | undefined): boolean {
  return activity?.state === "attn";
}

/**
 * Pick this pane's latest activity record out of the flat per-pane list `bsc logs pane-activity`
 * returns. A small helper so the predicate above and the poller in TerminalView agree on the lookup
 * (and so the gating logic is unit-testable end-to-end without a running poll).
 */
export function paneActivityFor(rows: PaneActivity[] | undefined, paneId: string): PaneActivity | undefined {
  return rows?.find((r) => r.pane === paneId);
}

/** Grace window after an `idle` event during which the turn is still treated as open (#1184). A
 *  fleet WORKER runs under the `bsc-defer` Stop hook: each turn records `idle`, bsc-defer blocks the
 *  stop, and the next turn's UserPromptSubmit reopens `run` a moment later. Without a debounce that
 *  momentary idle un-gates the silence timer and blinks the dot idle→run; the grace covers the gap. */
export const ACTIVITY_IDLE_GRACE_MS = 2500;

/**
 * Debounced turn-open check for the poller. Like {@link isTurnOpen}, but a freshly-`idle` pane is
 * still treated as open for `graceMs` after the idle event — smoothing the worker flicker above.
 * A genuinely done pane (its `idle` older than the grace) releases the gate, so the silence timer
 * idles it as normal. `run` is always open; no activity is never open (non-bash fallback unchanged).
 */
export function isTurnOpenDebounced(
  activity: PaneActivity | undefined,
  now: number,
  graceMs: number = ACTIVITY_IDLE_GRACE_MS,
): boolean {
  if (!activity) return false;
  if (activity.state === "run") return true;
  return now - activity.at < graceMs;
}
