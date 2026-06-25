// Fetch orchestration for the live Repo Pulse page (#413). Pulls the GitHub data
// the Pulse panels need through the ETag-cached backend (lib/github), then runs
// the pure mappers in lib/repoPulseLive to assemble a view model. Side-effectful;
// the mapping logic it calls is unit-tested separately.
//
// Cheap+exact panels (velocity, CI, review latency, branches) use list endpoints.
// Diff-derived panels (lines/day, churn-by-area, hottest files, contributor
// ±lines) need per-commit detail calls — capped to the most recent N commits.
import { useState, useEffect } from "react";
import { githubRequest, isGithubAuthError } from "@/features/github/lib/github";
import type { GithubRepo } from "@/store";
import {
  mapVelocity, mapChurnAreas, mapHottestFiles, mapContributors, mapCI,
  mapReviewLatency, mapBranches, deriveKpis,
  type GhCommitItem, type GhCommitDetail, type GhPull, type GhBranchItem,
  type GhWorkflowItem, type GhRun, type GhCompare, type CiHealth, type PulseKpis,
} from "@/features/github/lib/repoPulseLive";
import type {
  VelocitySlice, ChurnArea, ChurnFile, Contributor, Workflow, Branch,
} from "@/shared/data/repoPulse";

/** How many recent commits to fetch full diffs for (the diff-derived panels). */
const DETAIL_CAP = 40;
/** How many branches to run a compare (ahead/behind) call for. */
const COMPARE_CAP = 8;
const WINDOW_DAYS = 14;

export interface RepoPulseLive {
  repo: { name: string; branch: string; desc: string; lang: string; pushedMin: number };
  velocity: VelocitySlice;
  churnAreas: ChurnArea[];
  hottestFiles: ChurnFile[];
  contributors: Contributor[];
  ci: CiHealth;
  workflows: Workflow[];
  branches: Branch[];
  reviewBuckets: Array<{ label: string; v: number }>;
  kpis: PulseKpis;
  /** True while diff-derived panels reflect only the most recent DETAIL_CAP commits. */
  partialDiffs: boolean;
}

export interface UseRepoPulse {
  data: RepoPulseLive | null;
  loading: boolean;
  error: string | null;
}

function minutesSince(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}

export function useRepoPulse(repo: GithubRepo | null): UseRepoPulse {
  const [data, setData] = useState<RepoPulseLive | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slug = repo?.full_name ?? "";

  useEffect(() => {
    if (!repo || !slug) { setData(null); setError(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
        const get = <T,>(path: string, fallback: T): Promise<T> =>
          githubRequest<T>(path).catch((e) => { if (isGithubAuthError(e)) throw e; return fallback; });

        const [commits, pulls, branches, wfResp, runResp] = await Promise.all([
          get<GhCommitItem[]>(`repos/${slug}/commits?per_page=100&since=${since}`, []),
          get<GhPull[]>(`repos/${slug}/pulls?state=all&per_page=100&sort=created&direction=desc`, []),
          get<GhBranchItem[]>(`repos/${slug}/branches?per_page=100`, []),
          get<{ workflows: GhWorkflowItem[] }>(`repos/${slug}/actions/workflows`, { workflows: [] }),
          get<{ workflow_runs: GhRun[] }>(`repos/${slug}/actions/runs?per_page=100`, { workflow_runs: [] }),
        ]);
        if (cancelled) return;

        // Per-commit diffs for the most recent N commits (bounded, cached).
        const detailShas = commits.slice(0, DETAIL_CAP).map(c => c.sha);
        const details = (await Promise.all(
          detailShas.map(sha => get<GhCommitDetail | null>(`repos/${slug}/commits/${sha}`, null)),
        )).filter((d): d is GhCommitDetail => !!d);
        if (cancelled) return;

        // ahead/behind for the default branch vs a capped set of other branches.
        const defaultBranch = repo.default_branch;
        const compareTargets = branches
          .filter(b => b.name !== defaultBranch)
          .slice(0, COMPARE_CAP);
        const compareResults = await Promise.all(
          compareTargets.map(b =>
            get<GhCompare>(`repos/${slug}/compare/${defaultBranch}...${b.name}`, { ahead_by: 0, behind_by: 0 })
              .then(r => [b.name, r] as const)),
        );
        if (cancelled) return;
        const compares = Object.fromEntries(compareResults);

        const now = new Date();
        const velocity = mapVelocity(commits, pulls, details, WINDOW_DAYS, now);
        const { ci, workflows } = mapCI(runResp.workflow_runs, wfResp.workflows);
        const contributors = mapContributors(commits, details);

        const live: RepoPulseLive = {
          repo: {
            name: repo.full_name,
            branch: defaultBranch,
            desc: repo.description ?? "",
            lang: repo.language ? repo.language.toLowerCase() : "—",
            pushedMin: minutesSince(repo.pushed_at),
          },
          velocity,
          churnAreas: mapChurnAreas(details),
          hottestFiles: mapHottestFiles(details),
          contributors,
          ci,
          workflows,
          branches: mapBranches(branches, pulls, compares, defaultBranch),
          reviewBuckets: mapReviewLatency(pulls),
          kpis: deriveKpis(velocity, ci, pulls, contributors, now),
          partialDiffs: commits.length > DETAIL_CAP,
        };
        if (!cancelled) { setData(live); setLoading(false); }
      } catch (e) {
        if (cancelled) return;
        setError(isGithubAuthError(e) ? "GitHub authorization failed — reconnect in Settings." : "Couldn't load repo data from GitHub.");
        setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [repo, slug]);

  return { data, loading, error };
}
