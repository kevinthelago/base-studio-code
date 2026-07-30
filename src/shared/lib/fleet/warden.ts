// The warden's pure decision layer (#1102). The always-on loop (useWarden) gathers each live
// worker's trusted activity (git diff + bsc-audit) and plan anchor, and this module decides who
// has drifted off-plan — by running the deterministic, non-injectable checkConformance. Kept
// pure (no IPC, no store) so the "who trips" logic is unit-tested; the loop owns the side effects
// (auto-pause + push).

import type { WorktreeChanges } from "./worktreeChanges";
import { checkConformance, type StreamAnchor, type SessionActivity, type ConformanceTrip } from "./conformance";

/** One live worker the warden evaluates: its pane, its trusted anchor, and what it did. */
export interface WardenSession {
  paneId: string;
  anchor: StreamAnchor;
  activity: SessionActivity;
}

/** A worker the warden decided to quarantine, with a one-line summary for the push + UI. */
export interface WardenTrip {
  paneId: string;
  streamId: string;
  trips: ConformanceTrip[];
  summary: string;
}

/** Condense trips into one human line for the quarantine banner + the mobile push body.
 *  Deterministic, derived only from trusted signals — safe to surface and to send. */
export function summarizeTrips(trips: ConformanceTrip[]): string {
  if (trips.length === 0) return "on plan";
  const part = (t: ConformanceTrip) =>
    t.kind === "out-of-glob" ? `edited out-of-lane ${t.detail}` : `ran denied \`${t.detail}\``;
  const head = part(trips[0]);
  return trips.length === 1 ? head : `${head} (+${trips.length - 1} more)`;
}

/** Decide which sessions to quarantine this pass. Skips panes already quarantined (a trip is a
 *  one-shot hard pause, not a repeating alert) and any that pass the deterministic check. */
export function planWarden(sessions: WardenSession[], alreadyQuarantined: ReadonlySet<string>): WardenTrip[] {
  const out: WardenTrip[] = [];
  for (const s of sessions) {
    if (alreadyQuarantined.has(s.paneId)) continue;
    const verdict = checkConformance(s.anchor, s.activity);
    if (!verdict.onTask) {
      out.push({
        paneId: s.paneId,
        streamId: s.anchor.streamId,
        trips: verdict.trips,
        summary: summarizeTrips(verdict.trips),
      });
    }
  }
  return out;
}

/** Extract the shell commands a pane attempted from `bsc-audit` lines (`ts \t pane \t tool \t
 *  target`). Only Bash-tool rows are commands; their `target` is the command string. `since` (epoch
 *  ms, 0 = no floor) drops rows logged BEFORE it, so a denied command from a PRIOR run can't
 *  re-quarantine a worker that triage just relaunched — `ts` is ISO-8601 (`bsc-audit` writes
 *  `date -u +%Y-%m-%dT%H:%M:%SZ`), so `Date.parse` compares cleanly; an unparseable ts is kept. Pure. */
export function parseAuditCommands(lines: string[], paneId: string, since = 0): string[] {
  const cmds: string[] = [];
  for (const line of lines) {
    const f = line.split("\t");
    if (f.length < 4) continue;
    const [ts, pane, tool, target] = f;
    if (pane !== paneId || tool.trim().toLowerCase() !== "bash" || !target.trim()) continue;
    if (since > 0) {
      const at = Date.parse(ts);
      if (Number.isFinite(at) && at < since) continue;
    }
    cmds.push(target.trim());
  }
  return cmds;
}

/**
 * Zip a batched `read_worktree_changes_batch` result back onto the panes it was requested for (#3908).
 *
 * The batch is INDEX-ALIGNED to the cwds sent, so this is the one place a fleet-wide perf fix could
 * silently corrupt the warden's evidence: a short, long, or misordered result must never attribute
 * one worker's changed files to another — that would quarantine the wrong session. A missing entry
 * degrades to "no file signal", exactly as a failed single-pane read did before batching.
 */
export function zipWorktreeChanges(
  panes: string[],
  changes: readonly (WorktreeChanges | undefined)[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  // #3983: the LANE check reads TRACKED changes only. An untracked file has not entered the repo, is
  // not picked up by the lane's `git add`, and cannot collide at integration — which is the only harm
  // the lane exists to prevent. Merging the two lists made a `.agentscratch.txt` indistinguishable
  // from an out-of-lane source edit, and the warden killed four workers that had ZERO tracked changes
  // between them. Self-correcting rather than permissive: commit out-of-lane source and it becomes
  // tracked, and trips then — still before integration.
  panes.forEach((p, i) => out.set(p, changes[i]?.tracked ?? []));
  return out;
}

/**
 * The panes a warden sweep should actually probe (#3954): those with a RUNNING session.
 *
 * The sweep used to take the whole planned roster (`Object.keys(fleetPaneStreams)` minus completed
 * streams). That is the set of streams the PLAN defines, not the set that is running — so once the
 * resume rebuilt network-monitor's worktrees the sweep grew to 47 panes while only 3 terminals were
 * live, and each pane costs two git subprocesses. ~94 serial spawns inside one synchronous command
 * stalled the whole Tauri queue (`pty_write` measured at 3280ms, `pty_resize` at 8279ms).
 *
 * A pane with no session cannot be drifting: the warden watches what a RUNNING worker does to its
 * worktree, and there is nothing to watch when nothing is running. Liveness is the same definition
 * Glance and the launch pump use — present in a tab, and neither ended nor disabled — so all three
 * agree on "does this session exist?".
 *
 * Pure; the caller injects the store slices.
 */
export function wardenSweepTargets(
  panes: readonly string[],
  live: ReadonlySet<string>,
  completed: ReadonlySet<string>,
): string[] {
  return panes.filter((p) => live.has(p) && !completed.has(p));
}

/** The live pane set from the tab roster: in a tab, not ended, not disabled. Pure. */
export function livePaneIdsOf(
  tabs: readonly { paneIds?: string[] }[],
  ended: Record<string, unknown>,
  disabled: Record<string, unknown>,
): Set<string> {
  const out = new Set<string>();
  for (const t of tabs) for (const p of t.paneIds ?? []) {
    if (p && !ended[p] && !disabled[p]) out.add(p);
  }
  return out;
}
