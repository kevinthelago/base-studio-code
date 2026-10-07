// Campaign/content domain model + the draft→approve→schedule→publish state machine (#3148, epic
// #3145 P3). Pure (no React/Tauri) so the state machine is unit-testable independent of whatever
// store or backend ends up persisting it. A campaign grounds in the market-research stage
// (`bsc plan market`) via an optional `researchRef` snapshot — the gap/keyword/channel/pricing
// findings it was drafted from.

export type ChannelKind = "email" | "social" | "other";
export type ContentStatus = "draft" | "approved" | "scheduled" | "published";

export interface ContentMetrics {
  opens?: number;
  clicks?: number;
  impressions?: number;
  engagement?: number;
}

export interface ResearchRef {
  gap?: string;
  keywords?: string[];
  channels?: string[];
  pricing?: string;
}

export interface ContentItem {
  id: string;
  campaignId: string;
  /** The channel MCP server's name (e.g. "Channel (mock)", "Resend") — see lib/channels.ts. */
  channel: string;
  channelKind: ChannelKind;
  subject?: string;
  /** Required for email compliance (CAN-SPAM): company name + physical address. */
  senderIdentity?: string;
  body: string;
  status: ContentStatus;
  /** ISO-8601 — set on transition to "scheduled". */
  scheduleAt?: string;
  /** Epoch ms — set on transition to "published". */
  publishedAt?: number;
  /** The channel tool's receipt id (`<tool>-<n>`, crates/channel), once dispatched. */
  receiptId?: string;
  metrics?: ContentMetrics;
  createdAt: number;
  updatedAt: number;
}

export interface Campaign {
  id: string;
  name: string;
  researchRef?: ResearchRef;
  contentItemIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface NewContentInput {
  campaignId: string;
  channel: string;
  channelKind: ChannelKind;
  subject?: string;
  senderIdentity?: string;
  body: string;
}

export function newCampaign(name: string, id: string, now: number, researchRef?: ResearchRef): Campaign {
  return { id, name, researchRef, contentItemIds: [], createdAt: now, updatedAt: now };
}

export function newContentItem(input: NewContentInput, id: string, now: number): ContentItem {
  return {
    id,
    campaignId: input.campaignId,
    channel: input.channel,
    channelKind: input.channelKind,
    subject: input.subject,
    senderIdentity: input.senderIdentity,
    body: input.body,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
}

/** Allowed forward transitions — no backward moves, and critically "no publish from draft"
 *  (#3148): a draft must be approved first, then either scheduled or published directly. */
const TRANSITIONS: Record<ContentStatus, ContentStatus[]> = {
  draft: ["approved"],
  approved: ["scheduled", "published"],
  scheduled: ["published"],
  published: [],
};

export function canTransition(from: ContentStatus, to: ContentStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export type AdvanceResult =
  | { ok: true; item: ContentItem }
  | { ok: false; reason: string };

/** Advance `item` to `to` — pure; the caller (the store) applies the result. Rejects any
 *  transition not in {@link TRANSITIONS} with a human-readable reason rather than throwing, so a
 *  caller can surface it inline (e.g. a disabled button's tooltip). */
export function advanceStatus(
  item: ContentItem,
  to: ContentStatus,
  now: number,
  opts?: { scheduleAt?: string; receiptId?: string },
): AdvanceResult {
  if (!canTransition(item.status, to)) {
    return { ok: false, reason: `cannot move from ${item.status} to ${to}` };
  }
  if (to === "scheduled" && !opts?.scheduleAt && !item.scheduleAt) {
    return { ok: false, reason: "a schedule time is required" };
  }
  const next: ContentItem = { ...item, status: to, updatedAt: now };
  if (to === "scheduled") next.scheduleAt = opts?.scheduleAt ?? item.scheduleAt;
  if (to === "published") {
    next.publishedAt = now;
    if (opts?.receiptId) next.receiptId = opts.receiptId;
  }
  return { ok: true, item: next };
}

/** Scheduled items whose fire time has passed — the set a dispatcher should publish next
 *  (#3148: "scheduled items surface for dispatch"). */
export function dueForDispatch(items: ContentItem[], now: number): ContentItem[] {
  return items.filter((i) => i.status === "scheduled" && i.scheduleAt != null && new Date(i.scheduleAt).getTime() <= now);
}

/** Every content item belonging to a campaign, in creation order. */
export function contentForCampaign(items: ContentItem[], campaignId: string): ContentItem[] {
  return items.filter((i) => i.campaignId === campaignId).sort((a, b) => a.createdAt - b.createdAt);
}
