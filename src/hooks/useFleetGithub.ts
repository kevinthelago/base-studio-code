// Fleet GitHub-derived analytics (#415): throughput, merge queue, time-to-land,
// aggregated across the fleet's repos via the ETag-cached githubRequest. Pure
// mapping is in lib/fleetGithub; this is the fetch orchestration.
import { useState, useEffect } from "react";
import { githubRequest, isGithubAuthError } from "../lib/github";
import { useAppStore } from "../store";
import {
  mapThroughput, mapMergeQueue, mapTimeToLand, deriveThroughputKpis,
  type ThroughputSlice, type MergeQueueRow, type FleetThroughputKpis,
  type GhIssueItem, type GhStatusState,
} from "../lib/fleetGithub";
import type { GhPull } from "../lib/repoPulseLive";

const WINDOW_DAYS = 14;
/** Cap on open PRs we fetch a CI status for (one call each). */
const STATUS_CAP = 12;

/** A PR with the head sha we need for the combined-status call. */
interface GhPullFull extends GhPull { head: { ref: string; sha: string } }

export interface FleetGithub {
  throughput: ThroughputSlice;
  mergeQueue: MergeQueueRow[];
  timeToLand: Array<{ label: string; v: number }>;
  medianLandH: number;
  kpis: FleetThroughputKpis;
  loading: boolean;
  error: string | null;
  /** how many repos were aggregated. */
  repoCount: number;
}

const EMPTY: FleetGithub = {
  throughput: { labels: [], landed: [], merged: [] },
  mergeQueue: [], timeToLand: [], medianLandH: 0,
  kpis: { landedToday: 0, prsMergedWeek: 0, avgLandH: 0 },
  loading: false, error: null, repoCount: 0,
};

export function useFleetGithub(repos: string[], refreshNonce = 0): FleetGithub {
  const githubToken = useAppStore(s => s.githubToken);
  const [data, setData] = useState<FleetGithub>(EMPTY);
  const key = repos.join(",");

  useEffect(() => {
    if (!githubToken || repos.length === 0) { setData(EMPTY); return; }
    let cancelled = false;
    setData(d => ({ ...d, loading: true, error: null }));

    (async () => {
      try {
        const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
        const get = <T,>(path: string, fallback: T): Promise<T> =>
          githubRequest<T>(path).catch((e) => { if (isGithubAuthError(e)) throw e; return fallback; });

        // Pulls (all states) + recently-closed issues, per repo.
        const perRepo = await Promise.all(repos.map(async slug => {
          const [pulls, issues] = await Promise.all([
            get<GhPullFull[]>(`repos/${slug}/pulls?state=all&per_page=100&sort=updated&direction=desc`, []),
            get<GhIssueItem[]>(`repos/${slug}/issues?state=closed&per_page=100&since=${since}`, []),
          ]);
          return { slug, pulls, issues };
        }));
        if (cancelled) return;

        const allPulls: GhPull[] = perRepo.flatMap(r => r.pulls);
        const allIssues: GhIssueItem[] = perRepo.flatMap(r => r.issues);

        // Open PRs → fetch combined CI status for the head sha (bounded).
        const open = perRepo.flatMap(r => r.pulls.filter(p => p.state === "open").map(p => ({ pr: p, repo: r.slug })));
        const capped = open.slice(0, STATUS_CAP);
        const statuses = await Promise.all(capped.map(({ pr, repo }) =>
          get<{ state: GhStatusState }>(`repos/${repo}/commits/${pr.head.sha}/status`, { state: null as unknown as GhStatusState })
            .then(s => ({ pr, repo, status: s?.state ?? null }))));
        if (cancelled) return;

        const now = new Date();
        const throughput = mapThroughput(allPulls, allIssues, WINDOW_DAYS, now);
        const live: FleetGithub = {
          throughput,
          mergeQueue: mapMergeQueue(statuses),
          timeToLand: mapTimeToLand(allPulls),
          medianLandH: deriveThroughputKpis(throughput, allPulls, now).avgLandH,
          kpis: deriveThroughputKpis(throughput, allPulls, now),
          loading: false, error: null, repoCount: repos.length,
        };
        if (!cancelled) setData(live);
      } catch (e) {
        if (cancelled) return;
        setData({ ...EMPTY, error: isGithubAuthError(e) ? "GitHub authorization failed — reconnect in Settings." : "Couldn't load fleet activity from GitHub." });
      }
    })();

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, githubToken, refreshNonce]);

  return data;
}
