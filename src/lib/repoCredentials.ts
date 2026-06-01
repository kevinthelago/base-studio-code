// Repo-scoped GitHub credentials (#158) — the GitHub-proxy axis of per-session
// isolation. A session for repo A, given a repo-A-scoped token, makes its GitHub API
// calls with that token (not the global PAT), so it can't act on other repos via the
// proxy. The resolution is purely a function of the request path + the assigned tokens,
// so it's transport-free and unit-testable. (Filesystem/git confinement is separate.)

/**
 * The `owner/name` a GitHub REST path targets, or `null` when it isn't repo-scoped
 * (e.g. `user/repos`, `users/x/events`). Tolerates a leading slash and a query string.
 */
export function repoFromGitHubPath(path: string): string | null {
  const m = /^\/?repos\/([^/]+)\/([^/?#]+)/.exec(path);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Resolve the token for a request: the repo-scoped credential when the path targets a
 * repo that has one assigned, otherwise the global token. Matching is case-insensitive
 * on the `owner/name` (GitHub repo names are case-insensitive).
 */
export function resolveGithubToken(
  path: string,
  repoTokens: Record<string, string>,
  globalToken: string,
): string {
  const repo = repoFromGitHubPath(path);
  return tokenForRepo(repo, repoTokens, globalToken);
}

/**
 * Resolve the token for a session bound to a specific `owner/name` repo: the
 * repo-scoped credential when one is assigned, otherwise the global token. This is
 * the session axis of #158 — a worker/triage pane is launched with this token as its
 * `GH_TOKEN`, so its `gh`/`git` operations carry a fine-grained, repo-scoped credential
 * (when assigned) and can't act on sibling repos. Matching is case-insensitive on the
 * `owner/name` (GitHub repo names are case-insensitive). A null/empty `repo` (a console
 * with no bound repo, the director) falls back to the global token.
 */
export function tokenForRepo(
  repo: string | null | undefined,
  repoTokens: Record<string, string>,
  globalToken: string,
): string {
  if (!repo) return globalToken;
  const lower = repo.toLowerCase();
  for (const [k, v] of Object.entries(repoTokens)) {
    if (v && k.toLowerCase() === lower) return v;
  }
  return globalToken;
}
