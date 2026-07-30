// Idle session reaping (#849) — decide which background console PTYs to reap to bound
// memory when many projects accumulate hidden `claude` processes. PURE decision: given a
// snapshot of live panes + the reaper config + the clock, return the pane ids to reap. The
// hook (useIdleReaper) does the side effects (pty_kill + mark dormant); the store renders a
// dormant placeholder and resumes on focus. Framework-free + unit-tested.
//
// Reaping is non-destructive: a worktree/cwd persists on disk and the pane resumes via the
// existing relaunch path, so a reaped session is recoverable, not lost.

import type { SessionRole } from "@/shared/lib/session/sessionRoles";

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
  /** DECLARED maintenance (#4025): this worker emitted `bsc-maintain` — everything it owns is done
   *  and it is standing by for the director to dispatch into. Distinct from ordinary idling, which is
   *  why it gets its own rule below rather than a shorter `workerIdleMs`. */
  maintaining?: boolean;
}

export interface ReaperConfig {
  /** Master switch. */
  enabled: boolean;
  /** Idle threshold (ms) for reapable project/planner sessions. */
  idleMs: number;
  /** Idle threshold (ms) for workers + the director — conservative. `null` ⇒ never reap
   *  them (the default), since they idle legitimately (parked on a dep / the director). */
  workerIdleMs: number | null;
  /** Idle threshold (ms) for the app-owned STUDIO sessions (designer/librarian/architect, #3357).
   *  A studio session deliberately outlives the page that opened it — it stays warm on TerminalHost
   *  so its Glance node can morph into it — so this is how long it may sit with NO surface showing
   *  it before being reclaimed. Separate from `idleMs` because the trigger is different: the studio
   *  reaper counts *unwatched* time (viewer count 0), not time since last output.
   *  OPTIONAL for back-compat: a config persisted before #3357 has no such key, and zustand's
   *  persist replaces the whole object rather than merging, so readers MUST fall back to
   *  {@link DEFAULT_STUDIO_IDLE_MS} rather than trusting it to be present. */
  studioIdleMs?: number;
}

/** Default idle grace before an unwatched studio session is reclaimed (#3357). Also the fallback
 *  for a `ReaperConfig` persisted before the key existed. */
export const DEFAULT_STUDIO_IDLE_MS = 30 * 60 * 1000;

/** The effective studio idle threshold for a config, tolerating a pre-#3357 persisted object. */
export function studioIdleMs(cfg: ReaperConfig): number {
  return cfg.studioIdleMs ?? DEFAULT_STUDIO_IDLE_MS;
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
  // DECLARED MAINTENANCE (#4025) — reaped IMMEDIATELY, with no threshold.
  //
  // `workerIdleMs` is null by default because a worker "idles legitimately (parked on a dep / the
  // director)" — you cannot tell that apart from a worker that is done, so the safe answer was to reap
  // neither. Maintenance removes the ambiguity: the worker has SAID everything it owns is complete and
  // it is standing by. That is the one idle state where the PTY holds nothing worth keeping — measured
  // at ~413 MB per parked `claude.exe`, 13.7 GB across 34 of them.
  //
  // Deliberately NOT expressed as a shorter `workerIdleMs`: that would also reap a worker parked on a
  // real question, which is exactly the case the null default protects. And no grace period — a
  // dispatch relaunches with the assignment baked in (`actuateWake`), so a reaped maintainer is
  // reachable, which is what makes immediate reaping free rather than a trade.
  if (pane.maintaining) return true;
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
  studioIdleMs: DEFAULT_STUDIO_IDLE_MS,
};
