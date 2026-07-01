// Pure domain for the GitHub summary dashboard (#1644).
//
// All the React-free shaping the summary needs: the GraphQL contribution query,
// the GitHub event → activity mapping, the language/contributor/PR/CI/repo-grid
// aggregations, and the 28-week × 7-day activity-heatmap math. The data hook
// (`useGithubSummary`) and the card components consume these; nothing here imports
// React, so it's unit-testable in isolation.

import type { GHEvent } from "@/shared/lib/github/types";
import type { GithubRepo } from "@/store";
import { quartileScale } from "../heatScale";

// ── Wire types ────────────────────────────────────────────────────────────────

export interface GHPRItem {
  number: number;
  title: string;
  user: { login: string };
  created_at: string;
  draft: boolean;
}

export interface GHRunItem {
  id: number;
  status: string;
  conclusion: string | null;
  created_at: string;
}

export interface GHContrib {
  author: { login: string } | null;
  total: number;
}

export interface RepoData {
  prs: GHPRItem[];
  langBytes: Record<string, number>;
  runs: GHRunItem[];
  contribs: GHContrib[];
}

export interface ContribDay {
  date: string;    // YYYY-MM-DD
  weekday: number; // 0=Sun … 6=Sat (GitHub convention)
  count: number;
}

// ── Shaped output (card props) ────────────────────────────────────────────────

export interface CrossRepoEvent {
  login: string;
  action: string;
  target: string;
  repo: string;
  createdAt: string;
}

export interface OpenPR {
  n: string;
  t: string;
  who: string;
  repo: string;
  draft: boolean;
  age: string;
}

export interface Contributor {
  login: string;
  commits: number;
}

export interface CiRow {
  name: string;
  days: (boolean | null)[];
}

export interface RepoCardData {
  full_name: string;
  description: string | null;
  language: string | null;
  prCount: number;
  ciStatus: "passing" | "failing" | "unknown";
  lastPush: string;
  spark: number[];
}

export interface HeatmapData {
  heatmapCells: number[];
  rawCounts: number[];
  rawDates: string[];
  totalContribs: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** The summary samples only the N most-recently-updated repos (GitHub returns
 *  `user/repos` sorted `updated`). Surfaced on the cards so the sample size is honest. */
export const SUMMARY_REPO_SAMPLE = 6;

export const CONTRIB_QUERY = `
query GitHubContributions {
  viewer {
    contributionsCollection {
      contributionCalendar {
        weeks {
          contributionDays {
            contributionCount
            date
            weekday
          }
        }
      }
    }
  }
}`;

const LANG_COLORS: Record<string, string> = {
  Rust: "oklch(0.78 0.14 30)",
  TypeScript: "oklch(0.7 0.12 240)",
  JavaScript: "oklch(0.78 0.13 90)",
  Python: "oklch(0.78 0.12 90)",
  Go: "oklch(0.72 0.10 195)",
  Java: "oklch(0.7 0.12 50)",
  "C++": "oklch(0.75 0.10 240)",
  C: "oklch(0.72 0.08 220)",
  Shell: "oklch(0.72 0.10 145)",
  HTML: "oklch(0.7 0.12 30)",
  CSS: "oklch(0.7 0.10 260)",
};

export function langColor(lang: string): string {
  return LANG_COLORS[lang] ?? "oklch(0.5 0 0)";
}

export const EVENT_TONE: Record<string, string> = {
  merged: "var(--info)", opened: "var(--accent)", pushed: "var(--success)",
  reviewed: "var(--fg-muted)", closed: "var(--fg-dim)", created: "var(--accent)",
  commented: "var(--fg-dim)", "force-pushed": "var(--danger)",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

export function formatHeatDate(iso: string): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** Map a raw GitHub event to a `{ action, target }` for the activity feed, or null to drop it. */
export function mapEvent(evt: GHEvent): { action: string; target: string } | null {
  const p = evt.payload as Record<string, unknown>;
  switch (evt.type) {
    case "PushEvent": {
      const commits = p.commits as Array<{ message: string }> | undefined;
      const sha = (p.head as string | undefined)?.slice(0, 7) ?? "";
      const msg = commits?.[0]?.message?.split("\n")[0] ?? "";
      if (!sha && !msg) return null;
      return { action: "pushed", target: sha ? `${sha} ${msg}` : msg };
    }
    case "PullRequestEvent": {
      const pr = p.pull_request as { number: number; title: string; merged?: boolean } | undefined;
      if (!pr) return null;
      const action = p.action === "closed" && pr.merged ? "merged"
        : (p.action as string) ?? "updated";
      return { action, target: `#${pr.number} ${pr.title}` };
    }
    case "PullRequestReviewEvent": {
      const pr = p.pull_request as { number: number; title: string } | undefined;
      if (!pr) return null;
      return { action: "reviewed", target: `#${pr.number} ${pr.title}` };
    }
    case "IssuesEvent": {
      const issue = p.issue as { number: number; title: string } | undefined;
      if (!issue) return null;
      return { action: (p.action as string) ?? "updated", target: `#${issue.number} ${issue.title}` };
    }
    case "IssueCommentEvent": {
      const issue = p.issue as { number: number; title: string } | undefined;
      if (!issue) return null;
      return { action: "commented", target: `#${issue.number} ${issue.title}` };
    }
    case "CreateEvent": {
      const ref = p.ref as string | undefined;
      if (!ref) return null;
      return { action: "created", target: `${(p.ref_type as string) ?? "branch"} ${ref}` };
    }
    default:
      return null;
  }
}

// ── Derivations ───────────────────────────────────────────────────────────────

/** Map a contribution calendar (days) into 28-week × 7-day heatmap cells. */
export function buildHeatmap(contribDays: ContribDay[]): HeatmapData {
  const counts = new Array(28 * 7).fill(0);
  const dates = new Array(28 * 7).fill("");
  let totalContribs = 0;

  const now = new Date();
  const todayDow = (now.getDay() + 6) % 7; // Mon=0
  const currentWeekMon = new Date(now);
  currentWeekMon.setHours(0, 0, 0, 0);
  currentWeekMon.setDate(currentWeekMon.getDate() - todayDow);

  contribDays.forEach(day => {
    const [y, m, d] = day.date.split("-").map(Number);
    const date = new Date(y, m - 1, d); // local date
    const dayDow = (date.getDay() + 6) % 7; // Mon=0
    const dayWeekMon = new Date(date);
    dayWeekMon.setDate(dayWeekMon.getDate() - dayDow);
    const weeksAgo = Math.round((currentWeekMon.getTime() - dayWeekMon.getTime()) / (7 * 86400000));
    if (weeksAgo < 0 || weeksAgo >= 28) return;
    const col = 27 - weeksAgo;
    const row = (day.weekday + 6) % 7; // GitHub: 0=Sun → row 6; 1=Mon → row 0
    const idx = col * 7 + row;
    counts[idx] = day.count;
    dates[idx] = day.date;
    totalContribs += day.count;
  });

  // Quartile (rank-based) intensity — robust to outlier days; see heatScale.
  return { heatmapCells: quartileScale(counts), rawCounts: counts, rawDates: dates, totalContribs };
}

/** Count merged PRs in the event stream (last ~90 days). */
export function countMergedPRs(events: GHEvent[]): number {
  return events.reduce((n, evt) => {
    if (evt.type !== "PullRequestEvent") return n;
    const p = evt.payload as { action?: string; pull_request?: { merged?: boolean } };
    return n + (p?.action === "closed" && p?.pull_request?.merged ? 1 : 0);
  }, 0);
}

/** Latest ≤8 mappable cross-repo events for the activity feed. */
export function buildCrossRepoEvents(events: GHEvent[]): CrossRepoEvent[] {
  return events.slice(0, 60).map(evt => {
    const mapped = mapEvent(evt);
    if (!mapped) return null;
    return { login: evt.actor.login, ...mapped, repo: evt.repo.name, createdAt: evt.created_at };
  }).filter((e): e is CrossRepoEvent => e !== null).slice(0, 8);
}

/** Up to 8 open PRs across all sampled repos (≤3 per repo), with a humanized age. */
export function buildOpenPRs(repoData: Record<string, RepoData>, ageOf: (iso: string) => string): OpenPR[] {
  const all: OpenPR[] = [];
  Object.entries(repoData).forEach(([slug, rd]) => {
    rd.prs.slice(0, 3).forEach(pr => {
      all.push({ n: `#${pr.number}`, t: pr.title, who: pr.user.login, repo: slug, draft: pr.draft, age: ageOf(pr.created_at) });
    });
  });
  return all.slice(0, 8);
}

/** Top 5 contributors by commit count across all sampled repos. */
export function buildContributors(repoData: Record<string, RepoData>): Contributor[] {
  const totals: Record<string, number> = {};
  Object.values(repoData).forEach(rd => {
    rd.contribs.forEach(c => {
      if (!c.author) return;
      totals[c.author.login] = (totals[c.author.login] ?? 0) + c.total;
    });
  });
  return Object.entries(totals)
    .map(([login, commits]) => ({ login, commits }))
    .sort((a, b) => b.commits - a.commits)
    .slice(0, 5);
}

/** CI pass/fail matrix for the last 7 days per repo (rows with at least one run). */
export function buildCiMatrix(repos: GithubRepo[], repoData: Record<string, RepoData>): CiRow[] {
  return repos.slice(0, SUMMARY_REPO_SAMPLE).map(r => {
    const runs = repoData[r.full_name]?.runs ?? [];
    const name = r.full_name.split("/")[1] ?? r.full_name;
    const days = Array.from({ length: 7 }, (_, i) => {
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      dayStart.setDate(dayStart.getDate() - (6 - i));
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);
      const dayRuns = runs.filter(run => {
        const t = new Date(run.created_at).getTime();
        return t >= dayStart.getTime() && t < dayEnd.getTime() && run.status === "completed";
      });
      if (dayRuns.length === 0) return null as null;
      return dayRuns.some(run => run.conclusion === "success");
    });
    return { name, days };
  }).filter(m => m.days.some(d => d !== null));
}

/** Per-repo card data: PR count, CI status, and a 12-week commit sparkline from events. */
export function buildRepoGrid(repos: GithubRepo[], repoData: Record<string, RepoData>, events: GHEvent[]): RepoCardData[] {
  return repos.slice(0, SUMMARY_REPO_SAMPLE).map(r => {
    const rd = repoData[r.full_name];
    const runs = rd?.runs ?? [];
    const latestRun = runs[0];
    const ciStatus = latestRun
      ? (latestRun.conclusion === "success" ? "passing" : "failing")
      : "unknown";
    // Build commit sparkline (12 weeks) from user events for this repo
    const spark = new Array(12).fill(0);
    events.forEach(evt => {
      if (evt.type !== "PushEvent" || evt.repo.name !== r.full_name) return;
      const weeksAgo = Math.floor((Date.now() - new Date(evt.created_at).getTime()) / (7 * 86400000));
      if (weeksAgo < 12) {
        const p = evt.payload as { commits?: unknown[] };
        spark[11 - weeksAgo] += p?.commits?.length ?? 1;
      }
    });
    return { full_name: r.full_name, description: r.description, language: r.language, prCount: rd?.prs.length ?? 0, ciStatus: ciStatus as "passing" | "failing" | "unknown", lastPush: r.pushed_at, spark };
  });
}

/** Percent of sampled repos whose latest run succeeded, or null when none have runs. */
export function ciPassingPercent(repos: GithubRepo[], repoData: Record<string, RepoData>): number | null {
  const withRuns = repos.slice(0, SUMMARY_REPO_SAMPLE).filter(r => (repoData[r.full_name]?.runs.length ?? 0) > 0);
  if (withRuns.length === 0) return null;
  const passing = withRuns.filter(r => repoData[r.full_name]?.runs[0]?.conclusion === "success");
  return Math.round(passing.length / withRuns.length * 100);
}
