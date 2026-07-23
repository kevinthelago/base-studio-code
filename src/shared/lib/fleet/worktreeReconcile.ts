// worktreeReconcile (#3614) — heal the fleet split-brain at boot.
//
// The boot-GC (`fleet::teardown::gc_worktrees_impl`) reclaims a fleet worker's git worktree once its
// branch is merged + clean (the work landed) — a disk-hygiene feature. But it only deletes the DIRECTORY;
// the persisted `<project> · build` tab + its pane records survive. So on every boot the ghost tab
// mounts its panes and tries to relaunch workers into directories the app itself deleted → each spawns a
// doomed PTY → a burst of 8 jams the backend event loop → the whole app feels frozen. This module is the
// reconciliation: a worker whose worktree is gone has FINISHED (the GC only removes merged+clean), so it
// is marked ENDED (a resting card) rather than relaunched. `endedPanes` is persisted, so after one boot
// the tab renders resting workers and never thrashes again.
import type { EndedInfo } from "@/store/types/console";

/** A persisted fleet worker pane to check for a missing worktree at boot. */
export interface WorktreeCheck {
  paneId: string;
  cwd: string;
  streamId: string;
}

/** Which persisted fleet worker panes to worktree-check at boot: every pane with a fleet stream + a
 *  cwd that isn't already ended or disabled. (`paneRoles` is NOT persisted, so `fleetPaneStreams`
 *  membership is the worker filter — the same signal `useWorkerAutoEnd` uses.) Pure for testability. */
export function worktreeChecks(
  fleetPaneStreams: Record<string, { id: string } | undefined>,
  endedPanes: Record<string, unknown>,
  disabledPanes: Record<string, unknown>,
  paneCwds: Record<string, string>,
): WorktreeCheck[] {
  const checks: WorktreeCheck[] = [];
  for (const paneId of Object.keys(fleetPaneStreams)) {
    const stream = fleetPaneStreams[paneId];
    const cwd = paneCwds[paneId];
    if (!stream || !cwd || endedPanes[paneId] || disabledPanes[paneId]) continue;
    checks.push({ paneId, cwd, streamId: stream.id });
  }
  return checks;
}

/** The `EndedInfo` recorded for a worker whose worktree vanished. The boot-GC only reclaims a
 *  merged + clean worktree, so a gone worktree means the work landed → `done` (a resting card). */
export function reclaimedWorkerEnd(streamId: string, at: number): EndedInfo {
  return { state: "done", streamId, summary: "worktree reclaimed — work merged; session closed", at };
}

/**
 * For each candidate, check whether its worktree still exists; if gone (and not ended meanwhile), mark it
 * ended so it renders a resting card instead of relaunching into a deleted directory. Pure over its
 * injected deps (existence probe, ended-check, mark, clock) — the useAppBoot effect wires the real
 * `dir_exists` invoke + store. Returns the pane ids it ended (for logging/tests).
 */
export async function reconcileMissingWorktrees(
  checks: WorktreeCheck[],
  exists: (cwd: string) => Promise<boolean>,
  isEnded: (paneId: string) => boolean,
  markEnded: (paneId: string, info: EndedInfo) => void,
  now: () => number,
): Promise<string[]> {
  const ended: string[] = [];
  for (const c of checks) {
    if (await exists(c.cwd)) continue;   // worktree still there — leave the worker alone
    if (isEnded(c.paneId)) continue;      // #920 / a prior pass already ended it
    markEnded(c.paneId, reclaimedWorkerEnd(c.streamId, now()));
    ended.push(c.paneId);
  }
  return ended;
}
