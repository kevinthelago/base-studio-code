// Pure parsing + derivation for the Portfolio summary (ProjectsSummary.tsx).
// React-free so it can be unit-tested directly; the components consume the shapes
// returned here.

import type { GHEvent, GhMilestone, GhIssueItem as GhIssue } from "@/shared/lib/github/types";

// ── Types ─────────────────────────────────────────────────────────────────────

/** A viewer Projects V2 node, as returned by PROJECTS_SUMMARY_QUERY. */
export interface GhProject {
  id: string;
  number: number;
  title: string;
  shortDescription: string | null;
  closed: boolean;
  updatedAt: string;
  items: { totalCount: number };
  repositories: { nodes: Array<{ nameWithOwner: string }> };
}

// ── Palette ───────────────────────────────────────────────────────────────────

export const PROJECT_COLORS = [
  "oklch(0.78 0.14 70)",
  "oklch(0.7 0.10 220)",
  "oklch(0.7 0.12 145)",
  "oklch(0.6 0.06 50)",
  "oklch(0.7 0.12 290)",
  "oklch(0.45 0 0)",
];

// ── Cross-project activity ────────────────────────────────────────────────────

export const EVENT_TONE: Record<string, string> = {
  closed: "var(--success)", merged: "var(--info)", opened: "var(--accent)",
  moved: "var(--info)", linked: "var(--fg-muted)", published: "var(--accent)",
  commented: "var(--fg-dim)", created: "var(--accent)", reviewed: "var(--fg-muted)",
  pushed: "var(--success)",
};

/** Reduce a raw GitHub event to a verb + human target, or null if not interesting. */
export function mapGHEvent(evt: GHEvent): { action: string; target: string } | null {
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
      const action = p.action === "closed" && pr.merged ? "merged" : (p.action as string) ?? "updated";
      return { action, target: `#${pr.number} ${pr.title}` };
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

export interface ActivityEntry {
  login: string;
  action: string;
  target: string;
  repo: string;
  createdAt: string;
}

/** Build the cross-project activity feed: prefer events from the projects' repos,
 *  fall back to all events when too sparse, mapped + capped at 6. */
export function buildActivityFeed(events: GHEvent[], projects: GhProject[]): ActivityEntry[] {
  const projectRepos = new Set<string>();
  projects.forEach(p => p.repositories.nodes.forEach(r => projectRepos.add(r.nameWithOwner)));

  // Prefer events from project repos; fall back to all events
  let filtered = events.filter(e => projectRepos.has(e.repo.name));
  if (filtered.length < 3) filtered = events;

  return filtered.slice(0, 60).map(evt => {
    const mapped = mapGHEvent(evt);
    if (!mapped) return null;
    const repoShort = evt.repo.name.split("/").pop() ?? evt.repo.name;
    return { login: evt.actor.login, ...mapped, repo: repoShort, createdAt: evt.created_at };
  }).filter((e): e is NonNullable<typeof e> => e !== null).slice(0, 6);
}

// ── Velocity ──────────────────────────────────────────────────────────────────

export interface VelocityData {
  opened: number[];
  closed: number[];
  weekLabels: string[];
  avgClosed: string;
}

/** Issues opened vs closed across the last 8 weeks, plus the average weekly close rate. */
export function computeVelocity(repoIssues: Record<string, GhIssue[]>): VelocityData {
  const opened = new Array(8).fill(0);
  const closed = new Array(8).fill(0);
  const now = Date.now();

  Object.values(repoIssues).forEach(issues => {
    issues.forEach(issue => {
      if (issue.pull_request) return;
      const createdWeeksAgo = Math.floor((now - new Date(issue.created_at).getTime()) / (7 * 86400000));
      if (createdWeeksAgo < 8) opened[7 - createdWeeksAgo]++;
      if (issue.state === "closed" && issue.closed_at) {
        const closedWeeksAgo = Math.floor((now - new Date(issue.closed_at).getTime()) / (7 * 86400000));
        if (closedWeeksAgo < 8) closed[7 - closedWeeksAgo]++;
      }
    });
  });

  const weekLabels = Array.from({ length: 8 }, (_, i) => {
    const d = new Date(now - (7 - i) * 7 * 86400000);
    const start = new Date(d.getFullYear(), 0, 0);
    const week = Math.floor((d.getTime() - start.getTime()) / (7 * 86400000));
    return `w${week}`;
  });

  const avgClosed = (closed.reduce((s, v) => s + v, 0) / 8).toFixed(1);
  return { opened, closed, weekLabels, avgClosed };
}

/** Average issues-closed-per-week over the last 8 weeks, formatted (header stat). */
export function avgWeeklyClosed(repoIssues: Record<string, GhIssue[]>): string {
  const closed = new Array(8).fill(0);
  const now = Date.now();
  Object.values(repoIssues).forEach(issues => {
    issues.forEach(issue => {
      if (issue.pull_request || issue.state !== "closed" || !issue.closed_at) return;
      const weeksAgo = Math.floor((now - new Date(issue.closed_at).getTime()) / (7 * 86400000));
      if (weeksAgo < 8) closed[7 - weeksAgo]++;
    });
  });
  return (closed.reduce((s, v) => s + v, 0) / 8).toFixed(1);
}

/** Open (non-PR) issue count across all linked repos (header stat). */
export function countOpenIssues(repoIssues: Record<string, GhIssue[]>): number {
  return Object.values(repoIssues).reduce((s, issues) =>
    s + issues.filter(i => !i.pull_request && i.state === "open").length, 0);
}

// ── Upcoming milestones ───────────────────────────────────────────────────────

export interface UpcomingMilestone {
  title: string;
  repo: string;
  weeksFromNow: number;
  pct: number;
  overdue: boolean;
}

/** Open milestones due within the next 8 weeks, soonest first, capped at 6. */
export function computeUpcomingMilestones(repoMilestones: Record<string, GhMilestone[]>): UpcomingMilestone[] {
  const now = Date.now();
  const all: UpcomingMilestone[] = [];
  Object.entries(repoMilestones).forEach(([slug, milestones]) => {
    const repoName = slug.split("/")[1] ?? slug;
    milestones.forEach(ms => {
      if (!ms.due_on) return;
      const weeksFromNow = (new Date(ms.due_on).getTime() - now) / (7 * 86400000);
      if (weeksFromNow > 8) return; // beyond window
      const total = ms.open_issues + ms.closed_issues;
      const pct = total > 0 ? ms.closed_issues / total : 0;
      all.push({ title: ms.title, repo: repoName, weeksFromNow, pct, overdue: weeksFromNow < 0 });
    });
  });
  return all.sort((a, b) => a.weeksFromNow - b.weeksFromNow).slice(0, 6);
}

/** Milestones due in the next 2 weeks across all repos (header stat). */
export function countMilestonesDueSoon(repoMilestones: Record<string, GhMilestone[]>): number {
  const now = Date.now();
  return Object.values(repoMilestones).reduce((s, ms) =>
    s + ms.filter(m => {
      if (!m.due_on) return false;
      const weeksOut = (new Date(m.due_on).getTime() - now) / (7 * 86400000);
      return weeksOut >= 0 && weeksOut <= 2;
    }).length, 0);
}

// ── Project allocation ────────────────────────────────────────────────────────

export interface AllocationItem { n: string; pct: number; c: string }

/** Share of in-progress work (by item count) across active projects. */
export function computeAllocation(projects: GhProject[]): AllocationItem[] {
  const active = projects.filter(p => !p.closed && p.items.totalCount > 0);
  const total = active.reduce((s, p) => s + p.items.totalCount, 0);
  return active.map((p, i) => ({
    n: p.title,
    pct: total > 0 ? Math.round(p.items.totalCount / total * 100) : 0,
    c: PROJECT_COLORS[i % PROJECT_COLORS.length],
  }));
}

// ── Projects grid stats ───────────────────────────────────────────────────────

export type ProjectStatus = "shipped" | "drafting" | "active";

export interface ProjectStat {
  p: GhProject;
  c: string;
  status: ProjectStatus;
  spark: number[];
  repo: string;
}

/** Per-project card stats: color, status, a 9-week weekly-close sparkline, lead repo. */
export function computeProjectStats(projects: GhProject[], repoIssues: Record<string, GhIssue[]>): ProjectStat[] {
  return projects.map((p, i) => {
    const c = PROJECT_COLORS[i % PROJECT_COLORS.length];
    const status: ProjectStatus = p.closed ? "shipped" : p.items.totalCount === 0 ? "drafting" : "active";

    // Build weekly close sparkline from linked repos' issues
    const spark = new Array(9).fill(0);
    const now = Date.now();
    p.repositories.nodes.forEach(r => {
      const issues = repoIssues[r.nameWithOwner] ?? [];
      issues.forEach(issue => {
        if (issue.pull_request || issue.state !== "closed" || !issue.closed_at) return;
        const weeksAgo = Math.floor((now - new Date(issue.closed_at).getTime()) / (7 * 86400000));
        if (weeksAgo < 9) spark[8 - weeksAgo]++;
      });
    });

    const repo = p.repositories.nodes[0]?.nameWithOwner ?? "(no repo)";
    return { p, c, status, spark, repo };
  });
}

/** Distinct repo count linked across all projects (header stat). */
export function countLinkedRepos(projects: GhProject[]): number {
  return new Set(projects.flatMap(p => p.repositories.nodes.map(r => r.nameWithOwner))).size;
}
