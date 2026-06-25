// Per-pane turn-activity gating for the console status dot (#1184).
//
// The status dot's only per-turn signal is a 1.5s silence timer (`QUIET_MS` in TerminalView),
// which can't tell "done" from "working but silent" — so a worker that's thinking, running a long
// silent tool call, or backing off false-idles mid-turn. The fix drives authoritative turn
// boundaries from Claude Code hooks: `bsc-activity run` on UserPromptSubmit (a turn opens) and
// `bsc-activity idle` on Stop/SubagentStop (the turn closes), recorded to `activity.log`. The Rust
// `read_pane_activity` command returns the latest state per pane; TerminalView polls it and uses
// the pure helpers here to decide whether a pane's turn is still open.
//
// ADDITIVE / SAFE: the gate only PREVENTS a wrongful idle — a pane whose turn is still open is kept
// "run" past the silence timeout. It never forces idle on its own; a pane still goes idle on the
// authoritative Stop (which records `idle`, closing the turn) or, for non-bash / never-launched
// panes that emit no activity at all, on the silence timer exactly as before (no regression).

/** One pane's latest turn-boundary state, as serialized by the Rust `read_pane_activity` command
 *  (tokens.rs `PaneActivity` — plain snake_case, no serde rename, so the keys match the struct). */
export interface PaneActivity {
  pane: string;
  /** `"run"` — a turn is open (the agent is working); `"idle"` — the turn closed at a Stop. */
  state: "run" | "idle";
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
 * Pick this pane's latest activity record out of the flat per-pane list `read_pane_activity`
 * returns. A small helper so the predicate above and the poller in TerminalView agree on the lookup
 * (and so the gating logic is unit-testable end-to-end without a running poll).
 */
export function paneActivityFor(rows: PaneActivity[] | undefined, paneId: string): PaneActivity | undefined {
  return rows?.find((r) => r.pane === paneId);
}
