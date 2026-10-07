// Analytics read-back (#3149, epic #3145 P4) — the shapes + pure helpers for surfacing channel
// performance so the marketer iterates instead of firing blind. `ChannelMetricsReadout` mirrors the
// channel tool's own `get_metrics` shape (`{ total, by_tool }`, crates/channel) so the same readout
// the agent sees is what the UI displays.

import type { ContentItem } from "./campaign";

export interface ChannelMetricsReadout {
  total: number;
  byTool: Record<string, number>;
}

export interface CampaignMetricsSummary {
  published: number;
  opens: number;
  clicks: number;
  impressions: number;
}

/** Roll up per-item metrics across a set of content items (e.g. one campaign's items) — the
 *  aggregate a campaign card or analytics tab shows. Items with no metrics yet contribute zero
 *  (#3149: "a missing-metrics channel degrades gracefully" — never throws, never blocks the roll-up). */
export function summarizeMetrics(items: ContentItem[]): CampaignMetricsSummary {
  return items.reduce<CampaignMetricsSummary>(
    (acc, i) => {
      if (i.status === "published") acc.published += 1;
      acc.opens += i.metrics?.opens ?? 0;
      acc.clicks += i.metrics?.clicks ?? 0;
      acc.impressions += i.metrics?.impressions ?? 0;
      return acc;
    },
    { published: 0, opens: 0, clicks: 0, impressions: 0 },
  );
}

/** A metric count for display — "—" when there's nothing to show yet, rather than "0" (which reads
 *  as "confirmed zero" instead of "no data"). */
export function fmtMetric(n: number | undefined): string {
  return n == null || n === 0 ? "—" : n.toLocaleString();
}

/** A one-line channel readout for display, e.g. "3 sent · 2 send_email · 1 post". */
export function fmtChannelReadout(readout: ChannelMetricsReadout | null): string {
  if (!readout || readout.total === 0) return "no sends yet";
  const byTool = Object.entries(readout.byTool)
    .map(([tool, n]) => `${n} ${tool}`)
    .join(" · ");
  return `${readout.total} sent${byTool ? " · " + byTool : ""}`;
}
