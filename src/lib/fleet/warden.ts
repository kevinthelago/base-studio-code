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
 *  target`). Only Bash-tool rows are commands; their `target` is the command string. Pure. */
export function parseAuditCommands(lines: string[], paneId: string): string[] {
  const cmds: string[] = [];
  for (const line of lines) {
    const f = line.split("\t");
    if (f.length < 4) continue;
    const [, pane, tool, target] = f;
    if (pane === paneId && tool.trim().toLowerCase() === "bash" && target.trim()) {
      cmds.push(target.trim());
    }
  }
  return cmds;
}
