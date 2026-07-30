// Resume for a pane whose PTY is ALREADY ALIVE (#3998).
//
// Every Resume site in the app ultimately relies on `pty_create` to launch the agent — but
// `pty_create` returns before it ever reads `init_cmd` when a session already exists for the pane
// ("reconnect to existing session"). So for a live pane, the carefully-resolved
// `claude --continue 2>/dev/null || claude` is computed, handed to the backend, and thrown away.
// The pane gets a Ctrl+L repaint of its bash prompt and nothing else. That is why Resume appeared to
// do nothing on a session whose agent had already exited.
//
// `TerminalView` never remounts such a pane either: it is portal-hosted keyed by `paneId`, so the
// `runId` bump a resume performs re-keys the SLOT, not the terminal. Only a pane in a placeholder
// state (ended / disabled / dormant) unmounts and remounts.
//
// So the fix cannot live in the launch path — the launch path is unreachable. It has to act on the
// live shell directly: ask what the pane is actually doing, and if it is sitting at a prompt, type
// the resume command into it.

import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import { log } from "@/shared/lib/core/log";

/** `claude --continue`, degrading to a fresh session when there is no conversation to resume (#3937).
 *  Defined here rather than in `app/console/lib/resumeClaude.ts` so BOTH the mount-time launch path
 *  and this live-shell path emit the byte-identical command — a resumed pane must not depend on which
 *  of the two routes happened to reach it. stderr is dropped because claude's "no session" message is
 *  expected on the first `--continue` of a fresh worktree. */
export const CONTINUE_OR_FRESH = "claude --continue 2>/dev/null || claude";

/** What the backend reports for one pane (`pty_pane_runtime`). */
export type PaneRuntime = {
  paneId: string;
  /** A PTY session exists — `pty_create` would RECONNECT rather than launch. */
  live: boolean;
  /** Its shell has a live descendant, i.e. something is running in it. */
  busy: boolean;
};

/** Why a pane was or wasn't started, for logging and tests. */
export type ResumeOutcome = "started" | "already-running" | "not-live";

/**
 * Decide what a resume should do with each pane, given the backend's runtime report.
 *
 * Pure so the policy is testable without a live PTY. The three cases:
 *  - `not-live`     — no PTY yet. Do nothing: the pane's mount will run the normal launch path,
 *                     which handles `--continue` properly. Typing into a shell that doesn't exist
 *                     would be dropped anyway.
 *  - `already-running` — the shell has a descendant. Do nothing. This is the guard that stops a
 *                     resume from injecting a second `claude` into an agent that is mid-turn, and it
 *                     is why the backend probe asks about DESCENDANTS rather than trying to spot a
 *                     process named `claude` (which is `node.exe` on Windows).
 *  - `started`      — live, at a prompt. Type the resume command in.
 */
export function planResume(runtimes: readonly PaneRuntime[]): Map<string, ResumeOutcome> {
  const out = new Map<string, ResumeOutcome>();
  for (const r of runtimes) {
    out.set(r.paneId, !r.live ? "not-live" : r.busy ? "already-running" : "started");
  }
  return out;
}

/**
 * Make sure claude is running in each of `paneIds` whose PTY is alive but idle.
 *
 * Batched: the backend's busy check walks the process table, so asking about every pane at once costs
 * one walk instead of N — a project-wide resume touches dozens of panes.
 *
 * Returns the per-pane outcome so callers can report "started N" honestly instead of claiming a
 * resume that didn't happen.
 */
export async function ensureClaudeRunning(paneIds: readonly string[]): Promise<Map<string, ResumeOutcome>> {
  if (paneIds.length === 0) return new Map();
  const runtimes = await safeInvoke<PaneRuntime[]>("pty_pane_runtime", { paneIds: [...paneIds] }, []);
  const plan = planResume(runtimes);

  const started: string[] = [];
  for (const [paneId, outcome] of plan) {
    if (outcome !== "started") continue;
    // A plain write, NOT `injectPrompt`: that wraps text in bracketed-paste markers for claude's TUI,
    // and this is going to a bash prompt, where the markers would be echoed as literal characters.
    // The trailing newline is the Enter that runs it.
    await safeInvoke("pty_write", { paneId, data: `${CONTINUE_OR_FRESH}\n` }, undefined);
    started.push(paneId);
  }
  if (started.length > 0) {
    log.info(`resume: started claude in ${started.length} idle pane(s): ${started.join(", ")}`);
  }
  return plan;
}
