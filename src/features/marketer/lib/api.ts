// Contract-first bridge to the marketing backend (crates/marketing + its Tauri commands — the
// durable, bsc-CLI-reachable store #3148 describes, "reachable from a live session like the other
// stores"). That backend hasn't landed yet, so every call here degrades gracefully on failure — the
// same pattern `planner/bodies/sourceConnection.ts` uses for `data_platform_scan`: try the real
// invoke, and on rejection (command not registered) return null/no-op so the UI stays fully driven
// by the local store until the backend exists, then picks up the real data with no UI change.
//
// Command names are a PROPOSED contract (not yet implemented backend-side) — `marketing_*`, mirroring
// the `bsc marketing` CLI surface #3148 describes and the channel tool's own receipt/metrics shapes
// (crates/channel) so the same data reaches both the CLI and the desktop UI.

import { safeInvoke, fireInvoke } from "@/shared/lib/core/safeInvoke";
import type { Campaign, ContentItem } from "./campaign";
import type { ChannelMetricsReadout } from "./metrics";

/** Dispatch one approved/scheduled content item through its channel's MCP tool
 *  (send_email/post/schedule) — the backend resolves the stream's channel assignment and makes the
 *  real (confirm-gated, #3147) tool call, returning the channel's own receipt id (`<tool>-<n>`,
 *  crates/channel). Null when the backend command isn't wired yet. */
export async function dispatchContent(project: string, item: ContentItem): Promise<{ id: string } | null> {
  return safeInvoke<{ id: string } | null>("marketing_publish_content", { project, contentItemId: item.id }, null);
}

/** Read one channel's aggregate metrics (mirrors the channel tool's `get_metrics`). Null on
 *  failure — callers show "no data yet" rather than an error (#3149: a missing-metrics channel
 *  degrades gracefully). */
export async function fetchChannelMetrics(project: string, channel: string): Promise<ChannelMetricsReadout | null> {
  return safeInvoke<ChannelMetricsReadout | null>("marketing_channel_metrics", { project, channel }, null);
}

/** Load the durable campaign/content-item set for a project, if the backend store exists yet.
 *  Null (not `[]`) on failure, so the caller can tell "no backend" from "genuinely empty". */
export async function fetchCampaigns(project: string): Promise<{ campaigns: Campaign[]; contentItems: ContentItem[] } | null> {
  return safeInvoke("marketing_list_campaigns", { project }, null);
}

/** Fire-and-forget persistence of a campaign/content-item change to the durable backend store — the
 *  frontend's locally-persisted copy stays the source of truth until the backend lands (graceful
 *  degrade); once it does, every local mutation starts flowing through with no code change here. */
export function syncContentItem(project: string, item: ContentItem): void {
  fireInvoke("marketing_upsert_content", { project, item });
}

export function syncCampaign(project: string, campaign: Campaign): void {
  fireInvoke("marketing_upsert_campaign", { project, campaign });
}
