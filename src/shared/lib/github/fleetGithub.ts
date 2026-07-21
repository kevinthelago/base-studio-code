// Fleet GitHub-derived panels (#415) — PURE mappers over GitHub REST payloads
// aggregated across the fleet's repos: throughput (issues landed vs PRs merged),
// the director merge queue (open PRs + CI status), and time-to-land (merged-PR
// durations). Reuses the day-bucketing + review-latency helpers from
// repoPulseLive. Framework-free + unit-tested; fetch orchestration is in
// hooks/useFleetGithub.
import { mapReviewLatency, medianLatencyH, type GhPull } from "./repoPulseLive";
import { orderByRank } from "@/shared/lib/algorithms/orderByRank";
import { windowedTally } from "@/shared/lib/algorithms/windowedTally";
import type { GhIssueItem } from "@/shared/lib/github/types";

export type { GhPull };
// The issue-row shape (the `issues` endpoint also returns PRs — rows with `pull_request` set are
// PRs, excluded from "issues"). Canonical now lives in shared/lib/github/types (#1528); re-exported
// so existing importers (useFleetGithub, the tests) keep their `from "./fleetGithub"` import.
export type { GhIssueItem };

/** Combined commit status for a PR head (`commits/{sha}/status`). */
export type GhStatusState = "success" | "pending" | "failure" | "error" | string;

export interface ThroughputSlice { labels: string[]; landed: number[]; merged: number[] }

/**
 * Issues landed (closed, non-PR) vs PRs merged, per day over the window.
 *
 * The bucketing is the generic `windowedTally` (#3465), which is what guarantees the two series are
 * ALIGNED — one shared window, one entry per label in both. Tallying each series separately (as this
 * did) leaves nothing checking that they line up, and a chart layering them cannot tell.
 */
export function mapThroughput(pulls: GhPull[], issues: GhIssueItem[], days: number, now: Date): ThroughputSlice {
  const { labels, series } = windowedTally(
    {
      landed: issues.filter(i => !i.pull_request && i.closed_at).map(i => i.closed_at),
      merged: pulls.map(p => p.merged_at),
    },
    days,
    now,
  );
  return { labels, landed: series.landed, merged: series.merged };
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

/** The merge queue's ATTENTION order (#3465): ready-but-failing first (needs a human), then running,
 *  then green, then drafts. Declared as data + applied by the generic `orderByRank` — it was a chain
 *  of magic numbers inside a comparator, where this domain decision could not be read as a list. */
const MERGE_QUEUE_ORDER: MergeQueueRow["state"][] = ["blocked", "running", "green", "draft"];

/** Map open PRs (+ CI status) to merge-queue rows. Draft PRs read "draft";
 *  otherwise green/running/blocked from the combined commit status. */
export function mapMergeQueue(items: MergeQueueInput[]): MergeQueueRow[] {
  const rows = items.map(({ pr, repo, status }): MergeQueueRow => {
    const state: MergeQueueRow["state"] =
      pr.draft ? "draft"
      : status === "success" ? "green"
      : status === "pending" || status === null ? "running"
      : "blocked";
    const checks = pr.draft ? "draft" : status ?? "—";
    return { pr: `#${pr.number}`, repo, title: pr.title, state, checks };
  });
  return orderByRank(rows, (r) => r.state, MERGE_QUEUE_ORDER);
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
