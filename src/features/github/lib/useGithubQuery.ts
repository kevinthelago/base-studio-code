// useGithubQuery (#1496) — the GitHub fetch orchestration the planner/github screens hand-rolled:
// the `{ data, loading, error }` triple, the token gate, the cancel-guard, and the
// loading/error transitions. The screen-specific PARSE of the response stays in the screen (as a
// useMemo over `data`) — this hook only owns the fetch lifecycle.
//
// Mirrors the established pattern in useRepoPulse / useFleetGithub, generalized to any fetcher.

import { useEffect, useState, type DependencyList } from "react";
import { useAppStore } from "@/store";

export interface GithubQuery<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/**
 * Run `fetcher(token)` whenever `deps` (or the token) change, tracking `{ data, loading, error }`.
 * Skips while `enabled` is false or there's no token — leaving the last result in place, matching
 * the `if (!token || !x) return` gate the screens used. A stale in-flight request never lands
 * (cancel-guard), so rapid dep changes don't clobber the newest result.
 */
export function useGithubQuery<T>(
  fetcher: (token: string) => Promise<T>,
  deps: DependencyList,
  enabled = true,
): GithubQuery<T> {
  const githubToken = useAppStore((s) => s.githubToken);
  const [state, setState] = useState<GithubQuery<T>>({ data: null, loading: false, error: null });

  useEffect(() => {
    if (!githubToken || !enabled) return;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetcher(githubToken)
      .then((data) => { if (!cancelled) setState({ data, loading: false, error: null }); })
      .catch((e) => { if (!cancelled) setState((s) => ({ ...s, loading: false, error: String(e) })); });
    return () => { cancelled = true; };
    // `fetcher` is intentionally not a dep — callers declare the inputs it closes over via `deps`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [githubToken, enabled, ...deps]);

  return state;
}
