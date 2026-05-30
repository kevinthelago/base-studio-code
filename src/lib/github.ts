import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { resolveGithubToken } from "./repoCredentials";

/**
 * Default in-memory freshness window. Within this many seconds of the last fetch,
 * a revisit is served straight from the backend cache with **no network call** —
 * so navigating between screens doesn't refetch GitHub every time. After the
 * window the next call revalidates cheaply (ETag → 304). `force` (manual refresh)
 * always bypasses it; pass `maxAgeSecs: 0` to always revalidate-on-view.
 */
export const DEFAULT_MAX_AGE_SECS = 300;

export interface GithubRequestOpts {
  /** Serve the cached body without any network call when it's younger than this
   *  (seconds). Defaults to {@link DEFAULT_MAX_AGE_SECS}; pass 0 to always revalidate. */
  maxAgeSecs?: number;
  /** Bypass the cache + ETag and force a fresh fetch (manual refresh). */
  force?: boolean;
}

/** A `github_request` failure that is a 401 — the stored token is expired/revoked. */
export function isGithubAuthError(e: unknown): boolean {
  const s = String(e);
  return s.includes("401") || s.includes("Bad credentials");
}

/**
 * Call the GitHub REST API through the ETag-validated backend cache (`github_request`).
 *
 * - Pulls the token from the store, so callers just pass a path.
 * - Passes `maxAgeSecs`/`force` through to the cache: within `maxAgeSecs` the cached
 *   body is served with no network call; `force` bypasses the cache for a manual refresh.
 *   Otherwise the backend revalidates cheaply with `If-None-Match` (304 → cached).
 * - On a 401 (expired/revoked PAT) it flips the app to disconnected via
 *   {@link markGithubTokenInvalid} so the UI prompts a reconnect instead of
 *   silently 401-looping, then rethrows.
 */
export async function githubRequest<T>(path: string, opts: GithubRequestOpts = {}): Promise<T> {
  // Repo-scoped credentials (#158): a request targeting a repo with an assigned
  // fine-grained token uses it instead of the global PAT (so a session can't reach
  // other repos via the proxy); everything else uses the global token.
  const s = useAppStore.getState();
  const token = resolveGithubToken(path, s.repoGithubTokens, s.githubToken);
  try {
    return await invoke<T>("github_request", {
      token,
      path,
      maxAgeSecs: opts.maxAgeSecs ?? DEFAULT_MAX_AGE_SECS,
      force: opts.force,
    });
  } catch (e) {
    if (isGithubAuthError(e)) useAppStore.getState().markGithubTokenInvalid();
    throw e;
  }
}

/**
 * Call the GitHub GraphQL API through the backend cache (`github_graphql`).
 * GraphQL has no ETag, so the cache is purely time-windowed: within `maxAgeSecs`
 * (default {@link DEFAULT_MAX_AGE_SECS}) the cached result is served with no
 * network call; otherwise it re-POSTs. `force` bypasses. 401 → disconnect, as with
 * {@link githubRequest}.
 */
export async function githubGraphql<T>(
  query: string,
  variables: Record<string, unknown> | null,
  opts: GithubRequestOpts = {},
): Promise<T> {
  const token = useAppStore.getState().githubToken;
  try {
    return await invoke<T>("github_graphql", {
      token,
      query,
      variables,
      maxAgeSecs: opts.maxAgeSecs ?? DEFAULT_MAX_AGE_SECS,
      force: opts.force,
    });
  } catch (e) {
    if (isGithubAuthError(e)) useAppStore.getState().markGithubTokenInvalid();
    throw e;
  }
}

/** Drop the backend's cached GitHub responses (call on connect / disconnect / re-auth). */
export function clearGithubCache(): Promise<void> {
  return invoke("github_cache_clear");
}
