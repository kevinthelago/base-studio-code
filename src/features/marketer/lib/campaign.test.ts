import { describe, it, expect } from "vitest";
import {
  newCampaign, newContentItem, canTransition, advanceStatus, dueForDispatch, contentForCampaign,
  type ContentItem,
} from "./campaign";

function item(over: Partial<ContentItem> = {}): ContentItem {
  const base = newContentItem(
    { campaignId: "c1", channel: "Channel (mock)", channelKind: "email", body: "hello" },
    over.id ?? "i1",
    1000,
  );
  return { ...base, ...over };
}

describe("newCampaign / newContentItem", () => {
  it("mints a draft content item with no schedule/publish fields", () => {
    const i = newContentItem({ campaignId: "c1", channel: "Channel (mock)", channelKind: "email", body: "hi" }, "i1", 1000);
    expect(i.status).toBe("draft");
    expect(i.scheduleAt).toBeUndefined();
    expect(i.publishedAt).toBeUndefined();
  });

  it("mints a campaign with an empty content list", () => {
    const c = newCampaign("Launch week", "c1", 1000, { gap: "no self-hosted option", keywords: ["self-hosted"] });
    expect(c.contentItemIds).toEqual([]);
    expect(c.researchRef?.gap).toBe("no self-hosted option");
  });
});

describe("canTransition / advanceStatus", () => {
  it("allows draft → approved, approved → scheduled|published, scheduled → published", () => {
    expect(canTransition("draft", "approved")).toBe(true);
    expect(canTransition("approved", "scheduled")).toBe(true);
    expect(canTransition("approved", "published")).toBe(true);
    expect(canTransition("scheduled", "published")).toBe(true);
  });

  it("rejects publish directly from draft (#3148)", () => {
    expect(canTransition("draft", "published")).toBe(false);
    expect(canTransition("draft", "scheduled")).toBe(false);
  });

  it("rejects any move out of published (terminal)", () => {
    expect(canTransition("published", "draft")).toBe(false);
    expect(canTransition("published", "approved")).toBe(false);
  });

  it("advanceStatus returns ok:false with a reason for a disallowed transition", () => {
    const draft = item();
    const res = advanceStatus(draft, "published", 2000);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("draft");
  });

  it("advanceStatus approves a draft", () => {
    const draft = item();
    const res = advanceStatus(draft, "approved", 2000);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.item.status).toBe("approved");
      expect(res.item.updatedAt).toBe(2000);
    }
  });

  it("requires a schedule time to move to scheduled", () => {
    const approved = { ...item(), status: "approved" as const };
    const res = advanceStatus(approved, "scheduled", 2000);
    expect(res.ok).toBe(false);
  });

  it("scheduling sets scheduleAt; publishing sets publishedAt + receiptId", () => {
    const approved = { ...item(), status: "approved" as const };
    const scheduled = advanceStatus(approved, "scheduled", 2000, { scheduleAt: "2026-08-01T00:00:00Z" });
    expect(scheduled.ok).toBe(true);
    if (!scheduled.ok) return;
    expect(scheduled.item.scheduleAt).toBe("2026-08-01T00:00:00Z");

    const published = advanceStatus(scheduled.item, "published", 3000, { receiptId: "send_email-1" });
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    expect(published.item.publishedAt).toBe(3000);
    expect(published.item.receiptId).toBe("send_email-1");
  });
});

describe("dueForDispatch", () => {
  it("surfaces only scheduled items whose fire time has passed", () => {
    const past = { ...item({ id: "past" }), status: "scheduled" as const, scheduleAt: "2020-01-01T00:00:00Z" };
    const future = { ...item({ id: "future" }), status: "scheduled" as const, scheduleAt: "2999-01-01T00:00:00Z" };
    const draft = item({ id: "draft" });
    const due = dueForDispatch([past, future, draft], Date.parse("2026-01-01T00:00:00Z"));
    expect(due.map((i) => i.id)).toEqual(["past"]);
  });
});

describe("contentForCampaign", () => {
  it("filters by campaign and sorts by creation order", () => {
    const a = item({ id: "a", campaignId: "c1", createdAt: 200 });
    const b = item({ id: "b", campaignId: "c1", createdAt: 100 });
    const other = item({ id: "x", campaignId: "c2", createdAt: 50 });
    expect(contentForCampaign([a, b, other], "c1").map((i) => i.id)).toEqual(["b", "a"]);
  });
});
