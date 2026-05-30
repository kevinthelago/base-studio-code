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

## Scope & limits (this lands the GitHub-proxy axis)

- **GraphQL** (`githubGraphql`) still uses the global token — a GraphQL query has no repo
  in its URL to scope by. Repo-scoped GraphQL is a follow-up.
- **Filesystem / git confinement** — preventing a session's shell from traversing into
  sibling repos under `~/.base-studio-code/projects/` — is a separate concern (the Rust
  workspace/PTY layer) and a follow-up PR. The command/write-path gates (session-roles)
  already bound *what* a session can run/write.

## Data handling

No new external data flow: repo-scoped tokens are stored locally and sent only to
`api.github.com` (same as the existing PAT), so no legal-doc/privacy change is required.
