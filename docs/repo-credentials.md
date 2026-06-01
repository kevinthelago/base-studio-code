# Repo-scoped credentials (#158)

Per-session GitHub isolation: a session working on repo A makes its GitHub API calls
with a **repo-A-scoped token**, so it can't act on other repos through the proxy. This
is the third axis of the least-privilege model — **repo × role ([session-roles](session-roles.md)) × profile (Agents)**.

## How it works

- A user assigns a fine-grained, repo-scoped GitHub token to a repo in
  **Settings → GitHub → Repo credentials**. It's stored in the persisted app store
  (Tauri store), masked in the UI, and never logged — exactly like the global PAT.
- Every GitHub REST call goes through `githubRequest(path)`, which now resolves the
  token via [`resolveGithubToken`](../src/lib/repoCredentials.ts):
  - `repoFromGitHubPath(path)` extracts the `owner/name` a path targets
    (`repos/{owner}/{name}/…`); non-repo paths (`user/repos`, `users/x/events`) return
    `null`.
  - If that repo has an assigned token, the request uses it; otherwise the global PAT.
- The ETag cache keys by URL, and a given repo URL always resolves to the same token,
  so no cache change is needed (a URL never serves a response fetched under a different
  token).

A fine-grained token limited to repo A simply **can't** read/write/push repo B at
GitHub — the isolation is enforced by GitHub against the token's own scope, not just by
the client.

## Session shell axis — `GH_TOKEN` (`gh` / `git`)

The proxy axis above covers the desktop UI's own REST calls. A **Claude session** doesn't
use the proxy — it runs `gh` and `git` in its PTY, authenticated by the **`GH_TOKEN`**
env var the pane is launched with. So session isolation hinges on *which* token that is.

- At launch, [`TerminalView`](../src/components/pane/views/TerminalView.tsx) resolves the
  pane's token via [`tokenForRepo`](../src/lib/repoCredentials.ts): the pane is bound to
  an `owner/name` repo (`paneRepos[paneId]`, set at fleet/triage launch — a worker to its
  stream's repo, a triage pane to its repo), and if that repo has an assigned credential
  the session gets **that** token, otherwise the global PAT.
- That token is exported as `GH_TOKEN` into the PTY (and the #297 readiness probe), so the
  session's `gh pr create` / `git push` carry the repo-scoped credential. A fine-grained
  token limited to repo A makes `git push`/`gh` against repo B fail at GitHub — closing
  the cross-repo gap left when every session was launched with the broad global PAT (#362).
- The **director** spans every repo (it reviews/merges across the fleet), so it is left
  unbound and keeps the global token. Ad-hoc consoles with no bound repo likewise fall
  back to the global token.

`paneRepos` is persisted, so a restored session keeps its scope. The binding is the only
new state; resolution is the unit-tested `tokenForRepo` (a null/empty binding ⇒ global).

## Scope & limits

- **GraphQL** (`githubGraphql`) still uses the global token — a GraphQL query has no repo
  in its URL to scope by. Repo-scoped GraphQL is a follow-up.
- The session axis is only as strong as the token the user assigns: a broadly-scoped token
  assigned to a repo doesn't constrain the session. Use **fine-grained, single-repo**
  tokens for true isolation.

## Filesystem confinement (the file-tool axis)

A gated pane (one with a role or profile assigned) installs a **`bsc-confine`
PreToolUse hook** that blocks Claude's file tools (`Read`/`Edit`/`Write`/`MultiEdit`/
`NotebookEdit`) when their target path **escapes the session's repo root**
(`$BSC_REPO_ROOT`, the pane's cwd): any `..` segment, or an absolute path not under the
root, is denied (exit 2 + a reason on stderr). The decision is the unit-tested
[`isPathConfined`](../src/lib/fsConfine.ts); the hook mirrors it in portable shell
(string-based, no `realpath`). So a session for repo A can't read or write files in
sibling repos via its tools.

**Limits:**
- It covers the AI's **file tools**, not arbitrary **Bash** commands — `cat ../other`
  in a shell still works. True per-process FS jailing needs OS-level sandboxing
  (macOS `sandbox-exec`, Linux namespaces/bubblewrap, Windows AppContainer), which is a
  separate platform effort.
- The confinement is conservative: any `..` (even a within-repo `src/../x`) is denied.
- Triggered for gated panes; the cwd-rooted boundary is a launch-time value.

## Data handling

No new external data flow: repo-scoped tokens are stored locally and sent only to
`api.github.com` (same as the existing PAT), so no legal-doc/privacy change is required.
