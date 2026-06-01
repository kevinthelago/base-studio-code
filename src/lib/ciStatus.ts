// CI status rollup + the messages the CI watcher (#373) injects. Pure + unit-tested; the
// hook (useCiWatcher) supplies the live GitHub check-run data and actuates the prompts via
// pty_write. Closes the loop: a worker opens a PR and stops, CI runs unattended, and when it
// finishes the watcher tells the worker to continue (or fix) and nudges the director to merge.

/** A GitHub check run (the fields we use from the check-runs API). */
export interface CheckRun {
  name: string;
  /** "queued" | "in_progress" | "completed" */
  status: string;
  /** When completed: "success" | "failure" | "neutral" | "cancelled" | "timed_out" | "skipped" | "action_required" | null */
  conclusion: string | null;
  /** The commit sha this check ran against (used by the watchdog to identify develop's head, #378). */
  head_sha?: string;
}

export type CiState = "none" | "pending" | "passed" | "failed";

/** A conclusion that does NOT fail the build. */
const OK_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/**
 * Roll a PR head's check runs into a single CI state. "none" = no checks configured (so we
 * never block a worker on a repo without CI). "pending" = at least one not completed.
 * Otherwise "failed" if any completed run has a non-OK conclusion, else "passed".
 */
export function rollupChecks(runs: CheckRun[]): { state: CiState; failing: string[] } {
  if (runs.length === 0) return { state: "none", failing: [] };
  if (!runs.every((r) => r.status === "completed")) return { state: "pending", failing: [] };
  const failing = runs
    .filter((r) => !OK_CONCLUSIONS.has(r.conclusion ?? "failure"))
    .map((r) => r.name);
  return failing.length ? { state: "failed", failing } : { state: "passed", failing: [] };
}

/** A terminal state the watcher delivers on (passed/failed); pending/none are not delivered. */
export function isTerminalCi(s: CiState): s is "passed" | "failed" {
  return s === "passed" || s === "failed";
}

/** Message injected into the WORKER pane when its PR's CI finishes. Single line. */
export function ciWorkerPrompt(pr: number, state: "passed" | "failed", failing: string[]): string {
  if (state === "passed") {
    return `[ci] CI passed on your PR #${pr}. The director will merge it -- continue with your next assigned issue, or stop if you have none left. Do not reopen or duplicate this PR.`;
  }
  const list = failing.length ? failing.join(", ") : "see the PR checks";
  return `[ci] CI FAILED on your PR #${pr} (${list}). Inspect the failing job (gh pr checks ${pr}, gh run view --log-failed), fix the cause on your branch, commit, and push. Do not ask the user.`;
}

/** Message injected into the DIRECTOR pane when a worker's PR turns green. Single line. */
export function ciDirectorMergePrompt(pr: number, branch: string): string {
  return `[coordinator] PR #${pr} (branch ${branch}) is green and ready to merge. Review it and merge into develop (e.g. gh pr merge ${pr} --squash --delete-branch), then mark it with bsc-merged and keep the board/milestones current.`;
}

/** Prompt injected to a watchdog director when develop's CI goes red (#378). */
export function ciDevelopRedPrompt(repo: string, sha: string, failing: string[]): string {
  const jobs = failing.length ? failing.join(", ") : "one or more checks";
  return `[coordinator] develop CI is RED in ${repo} at ${sha.slice(0, 7)} (failing: ${jobs}). A worker self-merged a breaking change. Act now: identify the breaking commit (git log origin/develop), REVERT it to restore develop to green, then ping the owning worker — match the commit's changed paths to a stream's owned globs in CLAUDE.local.md and pipe a one-line fix-forward instruction into bsc-answer <session> on stdin. Do not let develop stay red.`;
}
