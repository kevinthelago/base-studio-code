// Idle session reaping (#849) — decide which background console PTYs to reap to bound
// memory when many projects accumulate hidden `claude` processes. PURE decision: given a
// snapshot of live panes + the reaper config + the clock, return the pane ids to reap. The
// hook (useIdleReaper) does the side effects (pty_kill + mark dormant); the store renders a
// dormant placeholder and resumes on focus. Framework-free + unit-tested.
//
// Reaping is non-destructive: a worktree/cwd persists on disk and the pane resumes via the
// existing relaunch path, so a reaped session is recoverable, not lost.

import type { SessionRole } from "./sessionRoles";

/** A live pane the reaper evaluates. */
export interface ReaperPane {
  paneId: string;
  /** Live PTY status: "run" = mid-turn (never reaped), "idle"/"on" = at rest. */
  status: "run" | "on" | "idle";
  role: SessionRole;
  /** Epoch ms of this pane's last activity (last status change / output). */
  lastActivityMs: number;
  /** The pane the user is currently watching — never reaped. */
  focused: boolean;
  /** Already dormant (reaped) — skip; nothing to reap twice. */
  dormant: boolean;
}

export interface ReaperConfig {
  /** Master switch. */
  enabled: boolean;
  /** Idle threshold (ms) for reapable project/planner sessions. */
  idleMs: number;
  /** Idle threshold (ms) for workers + the director — conservative. `null` ⇒ never reap
   *  them (the default), since they idle legitimately (parked on a dep / the director). */
  workerIdleMs: number | null;
}

/** Roles handled conservatively: they idle legitimately mid-fleet, so they're reaped only
 *  under the separate (longer / opt-in) `workerIdleMs`, never the project threshold. */
const CONSERVATIVE_ROLES: ReadonlySet<SessionRole> = new Set<SessionRole>(["worker", "director"]);

/** The idle threshold that applies to a pane by role, or `null` when its role is never
 *  reaped under the current config. */
export function thresholdFor(role: SessionRole, cfg: ReaperConfig): number | null {
  return CONSERVATIVE_ROLES.has(role) ? cfg.workerIdleMs : cfg.idleMs;
}

/** Whether a single pane is reapable right now. Exposed for focused unit tests. */
export function isReapable(pane: ReaperPane, cfg: ReaperConfig, nowMs: number): boolean {
  if (!cfg.enabled) return false;
  if (pane.dormant) return false;       // already reaped
  if (pane.focused) return false;       // the user is watching it
  if (pane.status === "run") return false; // mid-turn — never interrupt active work
  const threshold = thresholdFor(pane.role, cfg);
  if (threshold === null) return false; // this role is never reaped under the config
  return nowMs - pane.lastActivityMs >= threshold;
}

/**
 * The pane ids to reap from a snapshot. Selects only idle, non-focused, non-dormant panes
 * whose idle time exceeds the threshold for their role. A `run` (mid-turn) pane, the focused
 * pane, and — by default — workers/director are never selected.
 */
export function panesToReap(panes: readonly ReaperPane[], cfg: ReaperConfig, nowMs: number): string[] {
  return panes.filter((p) => isReapable(p, cfg, nowMs)).map((p) => p.paneId);
}

/** Sensible conservative defaults: on, 30 min for project sessions, workers/director never
 *  reaped (opt-in). Surfaced in Settings; persisted. */
export const DEFAULT_REAPER_CONFIG: ReaperConfig = {
  enabled: true,
  idleMs: 30 * 60 * 1000,
  workerIdleMs: null,
};
