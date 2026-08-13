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

// THE THREE PROMPT BUILDERS ARE GONE (#coord-prefix-names-the-sender): ciWorkerPrompt,
// ciDirectorMergePrompt and ciDevelopRedPrompt had NO reference anywhere in src/ outside their own
// definitions — the watcher that injected them was removed with the rest of the pumps.
//
// ciDirectorMergePrompt is the reason DELETING beat leaving them inert: it told the director to run
// `gh pr merge`, and under local-first the director holds no GitHub write — `director.rs` now asserts
// the protocol does NOT contain that string. An inert builder would have preserved the contradiction
// for whoever revived it.
