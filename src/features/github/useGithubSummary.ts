// Data hook for the GitHub summary dashboard (#1644).
//
// Owns the fetch lifecycle (events + contribution calendar + per-repo PRs/languages/
// runs/contributors for the N most-recently-updated repos) and exposes the memoized
// derivations every card renders from. All the React-free shaping lives in
// `lib/githubSummary.ts`; this hook only wires fetch → state → derived view models.

import { useState, useEffect, useMemo } from "react";
import { useAppStore } from "@/store";
import { timeAgo } from "@/shared/lib/core/format";
import { githubRequest, githubGraphql } from "@/shared/lib/github/github";
import { languageStats } from "./languageStats";
import type { GHEvent } from "@/shared/lib/github/types";
import {
  SUMMARY_REPO_SAMPLE,
  CONTRIB_QUERY,
  buildHeatmap,
  countMergedPRs,
  buildCrossRepoEvents,
  buildOpenPRs,
  buildContributors,
  buildCiMatrix,
  buildRepoGrid,
  ciPassingPercent,
  type GHPRItem,
  type GHRunItem,
  type GHContrib,
  type RepoData,
  type ContribDay,
} from "./lib/githubSummary";

/** Raw fetched state, before the per-card derivations. */
function useGitHubSummaryData() {
  const { githubToken, githubUser, githubRepos } = useAppStore();
  const [loading, setLoading] = useState(false);
  const [events, setEvents] = useState<GHEvent[]>([]);
  const [repoData, setRepoData] = useState<Record<string, RepoData>>({});
  const [contribDays, setContribDays] = useState<ContribDay[]>([]);

  const slugKey = githubRepos.slice(0, SUMMARY_REPO_SAMPLE).map(r => r.full_name).join(",");

  useEffect(() => {
    if (!githubToken || !githubUser) return;
    const login = githubUser.login;
    const slugs = githubRepos.slice(0, SUMMARY_REPO_SAMPLE).map(r => r.full_name);
    if (slugs.length === 0 && !login) return;

    setLoading(true);

    const eventsP = githubRequest<GHEvent[]>(`users/${login}/events?per_page=100`).catch((): GHEvent[] => []);

    const contribP = githubGraphql<{
      viewer: { contributionsCollection: { contributionCalendar: { weeks: Array<{ contributionDays: Array<{ contributionCount: number; date: string; weekday: number }> }> } } }
    }>(CONTRIB_QUERY, null).then(d => {
      const weeks = d?.viewer?.contributionsCollection?.contributionCalendar?.weeks ?? [];
      const days: ContribDay[] = [];
      weeks.forEach(w => w.contributionDays.forEach(cd => days.push({ date: cd.date, weekday: cd.weekday, count: cd.contributionCount })));
      return days;
    }).catch((): ContribDay[] => []);

    const repoPs = slugs.map(slug =>
      Promise.all([
        githubRequest<GHPRItem[]>(`repos/${slug}/pulls?state=open&per_page=20`).catch((): GHPRItem[] => []),
        githubRequest<Record<string, number>>(`repos/${slug}/languages`).catch((): Record<string, number> => ({})),
        githubRequest<{ workflow_runs: GHRunItem[] }>(`repos/${slug}/actions/runs?per_page=30`)
          .catch(() => ({ workflow_runs: [] as GHRunItem[] })),
        githubRequest<unknown>(`repos/${slug}/stats/contributors`)
          .then(d => Array.isArray(d) ? d as GHContrib[] : []).catch((): GHContrib[] => []),
      ])
    );

    Promise.all([eventsP, contribP, ...repoPs]).then(([evts, days, ...rows]) => {
      const evtArr = Array.isArray(evts) ? evts : [];
      const rd: Record<string, RepoData> = {};
      slugs.forEach((slug, i) => {
        const [prs, langs, runsResp, contribs] = rows[i] as [
          GHPRItem[],
          Record<string, number>,
          { workflow_runs: GHRunItem[] },
          GHContrib[],
        ];
        rd[slug] = {
          prs: Array.isArray(prs) ? prs : [],
          langBytes: langs && typeof langs === "object" && !Array.isArray(langs) ? langs : {},
          runs: Array.isArray(runsResp?.workflow_runs) ? runsResp.workflow_runs : [],
          contribs: Array.isArray(contribs) ? contribs : [],
        };
      });
      setEvents(evtArr);
      setContribDays(Array.isArray(days) ? days : []);
      setRepoData(rd);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [githubToken, githubUser?.login, slugKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return { loading, events, repoData, contribDays };
}

/**
 * The summary's full view model: the fetch state plus every per-card derivation
 * (heatmap, contributors, open PRs, CI matrix, repo grid, language mix, KPIs).
 */
export function useGithubSummary() {
  const githubRepos = useAppStore(s => s.githubRepos);
  const { loading, events, repoData, contribDays } = useGitHubSummaryData();

  const heatmap = useMemo(() => buildHeatmap(contribDays), [contribDays]);
  const totalMerged = useMemo(() => countMergedPRs(events), [events]);
  const crossRepoEvts = useMemo(() => buildCrossRepoEvents(events), [events]);
  const openPRs = useMemo(() => buildOpenPRs(repoData, timeAgo), [repoData]);
  const { totals: langTotals, repoCount: langRepoCount } = useMemo(() => languageStats(repoData), [repoData]);
  const contributors = useMemo(() => buildContributors(repoData), [repoData]);
  const ciMatrix = useMemo(() => buildCiMatrix(githubRepos, repoData), [githubRepos, repoData]);
  const repoGridData = useMemo(() => buildRepoGrid(githubRepos, repoData, events), [githubRepos, repoData, events]);

  // KPIs
  const kpiOpenPRs = Object.values(repoData).reduce((s, rd) => s + rd.prs.length, 0);
  const kpiContribs = contributors.length || "—";
  const kpiCIPassing = ciPassingPercent(githubRepos, repoData);

  return {
    loading,
    githubRepos,
    heatmap,
    totalMerged,
    crossRepoEvts,
    openPRs,
    langTotals,
    langRepoCount,
    contributors,
    ciMatrix,
    repoGridData,
    kpiOpenPRs,
    kpiContribs,
    kpiCIPassing,
  };
}
