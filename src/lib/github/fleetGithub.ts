// Fleet GitHub-derived panels (#415) — PURE mappers over GitHub REST payloads
// aggregated across the fleet's repos: throughput (issues landed vs PRs merged),
// the director merge queue (open PRs + CI status), and time-to-land (merged-PR
// durations). Reuses the day-bucketing + review-latency helpers from
// repoPulseLive. Framework-free + unit-tested; fetch orchestration is in
// hooks/useFleetGithub.
import { dayWindow, tallyByDay, mapReviewLatency, medianLatencyH, type GhPull } from "./repoPulseLive";

export type { GhPull };

/** An issue from the `issues` endpoint. Note: that endpoint returns PRs too —
 *  rows with `pull_request` set are PRs and must be excluded from "issues". */
export interface GhIssueItem {
  number: number;
  title: string;
  closed_at: string | null;
  state: string;
  pull_request?: unknown;
}

/** Combined commit status for a PR head (`commits/{sha}/status`). */
export type GhStatusState = "success" | "pending" | "failure" | "error" | string;

export interface ThroughputSlice { labels: string[]; landed: number[]; merged: number[] }

/** Issues landed (closed, non-PR) vs PRs merged, per day over the window. */
export function mapThroughput(pulls: GhPull[], issues: GhIssueItem[], days: number, now: Date): ThroughputSlice {
  const win = dayWindow(days, now);
  const landedDates = issues
    .filter(i => !i.pull_request && i.closed_at)
    .map(i => i.closed_at);
  return {
    labels: win.labels,
    landed: tallyByDay(win, landedDates),
    merged: tallyByDay(win, pulls.map(p => p.merged_at)),
  };
}

/** A PR awaiting integration, with its repo + CI state. */
export interface MergeQueueInput {
  pr: GhPull;
  repo: string;
  /** combined commit status for the head, or null if unknown. */
  status: GhStatusState | null;
}
export interface MergeQueueRow {
  pr: string;
  repo: string;
  title: string;
  state: "green" | "running" | "blocked" | "draft";
  checks: string;
}

/** Map open PRs (+ CI status) to merge-queue rows. Draft PRs read "draft";
 *  otherwise green/running/blocked from the combined commit status. */
export function mapMergeQueue(items: MergeQueueInput[]): MergeQueueRow[] {
  return items.map(({ pr, repo, status }) => {
    const state: MergeQueueRow["state"] =
      pr.draft ? "draft"
      : status === "success" ? "green"
      : status === "pending" || status === null ? "running"
      : "blocked";
    const checks = pr.draft ? "draft" : status ?? "—";
    return { pr: `#${pr.number}`, repo, title: pr.title, state, checks };
  })
  // Ready-but-failing first, then running, then green, then drafts — the queue's
  // attention order.
  .sort((a, b) => order(a.state) - order(b.state));
}
function order(s: MergeQueueRow["state"]): number {
  return s === "blocked" ? 0 : s === "running" ? 1 : s === "green" ? 2 : 3;
}

// Re-export the shared latency mappers so the Fleet hook imports from one place.
export { mapReviewLatency as mapTimeToLand, medianLatencyH };

export interface FleetThroughputKpis {
  landedToday: number;
  prsMergedWeek: number;
  avgLandH: number;
}
export function deriveThroughputKpis(throughput: ThroughputSlice, pulls: GhPull[], now: Date): FleetThroughputKpis {
  const within = (iso: string | null, ms: number) => !!iso && (now.getTime() - new Date(iso).getTime()) <= ms;
  return {
    landedToday: throughput.landed[throughput.landed.length - 1] ?? 0,
    prsMergedWeek: pulls.filter(p => within(p.merged_at, 7 * 86_400_000)).length,
    avgLandH: medianLatencyH(pulls.filter(p => within(p.merged_at, 14 * 86_400_000))),
  };
}
