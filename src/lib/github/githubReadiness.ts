// Pure interpretation of a session's GitHub readiness probe (#297).
//
// Fleet agents are told to push branches and open PRs, but a spawned session can
// silently lack the tools to do so — `gh`/`git` missing from the shell's PATH, or
// `gh` present but unauthenticated. The backend probe (`github_readiness`) runs the
// checks in the same environment the agent's `bash -c` subshells use; this module
// turns its raw booleans into a single actionable status, so the pane can warn the
// user up front instead of the agent discovering the gap mid-task.
//
// Free of React/Tauri imports so it can be unit-tested and shared.

/** Raw result of the backend probe — three independent checks. */
export interface GithubProbe {
  /** `command -v gh` succeeded in the session shell. */
  ghOnPath: boolean;
  /** `command -v git` succeeded in the session shell. */
  gitOnPath: boolean;
  /** `gh auth status` exited 0 (token or `gh auth login` present). */
  ghAuthed: boolean;
}

/** Single worst-first status; `ready` means all checks passed. */
export type GithubReadinessStatus =
  | "ready"
  | "git-missing"
  | "gh-missing"
  | "gh-unauthed";

export interface GithubReadiness {
  status: GithubReadinessStatus;
  /** True only when the session can commit, push, and open PRs. */
  ok: boolean;
  /** Actionable, user-facing one-liner — empty when `ok`. */
  message: string;
}

/**
 * Collapse the three probe checks into one actionable status. Precedence is
 * worst-first: a missing `git` is the most fundamental failure (no repo ops at
 * all), then a missing `gh` (no PRs), then an unauthenticated `gh` (installed but
 * can't act). The first failing check wins so the message names the single next
 * step the user should take.
 */
export function interpretGithubReadiness(probe: GithubProbe): GithubReadiness {
  if (!probe.gitOnPath) {
    return {
      status: "git-missing",
      ok: false,
      message:
        "git is not on this session's PATH — commits and pushes will fail. Install git or add it to PATH, then relaunch.",
    };
  }
  if (!probe.ghOnPath) {
    return {
      status: "gh-missing",
      ok: false,
      message:
        "GitHub CLI (gh) is not on this session's PATH — agents can't open PRs. Install it from https://cli.github.com or add it to PATH, then relaunch.",
    };
  }
  if (!probe.ghAuthed) {
    return {
      status: "gh-unauthed",
      ok: false,
      message:
        "GitHub CLI (gh) is installed but not authenticated — set GH_TOKEN or run `gh auth login`. Agents can't push or open PRs until then.",
    };
  }
  return { status: "ready", ok: true, message: "" };
}
