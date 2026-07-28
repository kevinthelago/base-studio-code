// The warden's pure decision layer (#1102). The always-on loop (useWarden) gathers each live
// worker's trusted activity (git diff + bsc-audit) and plan anchor, and this module decides who
// has drifted off-plan — by running the deterministic, non-injectable checkConformance. Kept
// pure (no IPC, no store) so the "who trips" logic is unit-tested; the loop owns the side effects
// (auto-pause + push).

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
export function zipWorktreeChanges(panes: string[], changes: readonly (string[] | undefined)[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  panes.forEach((p, i) => out.set(p, changes[i] ?? []));
  return out;
}
