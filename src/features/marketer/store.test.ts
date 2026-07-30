import { describe, it, expect, beforeEach } from "vitest";
import { useMarketerStore } from "./store";

const emailInput = { campaignId: "c1", channel: "Resend", channelKind: "email" as const, body: "Buy now! Unsubscribe: /u", senderIdentity: "Acme, 1 Main St" };
const badEmailInput = { campaignId: "c1", channel: "Resend", channelKind: "email" as const, body: "Buy now!" }; // no unsubscribe/sender

beforeEach(() => {
  useMarketerStore.setState({ campaigns: [], contentItems: [] });
});

describe("campaign CRUD", () => {
  it("adds a campaign and links content items to it", () => {
    const campId = useMarketerStore.getState().addCampaign("Launch week");
    const itemId = useMarketerStore.getState().addContentItem({ ...emailInput, campaignId: campId });
    expect(useMarketerStore.getState().campaigns[0].contentItemIds).toEqual([itemId]);
    expect(useMarketerStore.getState().contentItems[0].status).toBe("draft");
  });

  it("removing a campaign cascades to its content items", () => {
    const campId = useMarketerStore.getState().addCampaign("Launch week");
    useMarketerStore.getState().addContentItem({ ...emailInput, campaignId: campId });
    useMarketerStore.getState().removeCampaign(campId);
    expect(useMarketerStore.getState().campaigns).toEqual([]);
    expect(useMarketerStore.getState().contentItems).toEqual([]);
  });

  it("removing a content item unlinks it from its campaign", () => {
    const campId = useMarketerStore.getState().addCampaign("Launch week");
    const itemId = useMarketerStore.getState().addContentItem({ ...emailInput, campaignId: campId });
    useMarketerStore.getState().removeContentItem(itemId);
    expect(useMarketerStore.getState().campaigns[0].contentItemIds).toEqual([]);
    expect(useMarketerStore.getState().contentItems).toEqual([]);
  });
});

describe("approveContentItem — the compliance gate (#3150)", () => {
  it("blocks approval and reports violations for noncompliant content", () => {
    const campId = useMarketerStore.getState().addCampaign("Launch week");
    const itemId = useMarketerStore.getState().addContentItem({ ...badEmailInput, campaignId: campId });
    const res = useMarketerStore.getState().approveContentItem(itemId);
    expect(res.ok).toBe(false);
    expect(res.violations.length).toBeGreaterThan(0);
    expect(useMarketerStore.getState().contentItems[0].status).toBe("draft");
  });

  it("approves compliant content", () => {
    const campId = useMarketerStore.getState().addCampaign("Launch week");
    const itemId = useMarketerStore.getState().addContentItem({ ...emailInput, campaignId: campId });
    const res = useMarketerStore.getState().approveContentItem(itemId);
    expect(res.ok).toBe(true);
    expect(useMarketerStore.getState().contentItems[0].status).toBe("approved");
  });
});

describe("scheduleContentItem", () => {
  it("rejects scheduling a draft (must be approved first)", () => {
    const campId = useMarketerStore.getState().addCampaign("Launch week");
    const itemId = useMarketerStore.getState().addContentItem({ ...emailInput, campaignId: campId });
    const res = useMarketerStore.getState().scheduleContentItem(itemId, "2026-08-01T00:00:00Z");
    expect(res.ok).toBe(false);
  });

  it("schedules an approved item", () => {
    const campId = useMarketerStore.getState().addCampaign("Launch week");
    const itemId = useMarketerStore.getState().addContentItem({ ...emailInput, campaignId: campId });
    useMarketerStore.getState().approveContentItem(itemId);
    const res = useMarketerStore.getState().scheduleContentItem(itemId, "2026-08-01T00:00:00Z");
    expect(res.ok).toBe(true);
    expect(useMarketerStore.getState().contentItems[0].status).toBe("scheduled");
    expect(useMarketerStore.getState().contentItems[0].scheduleAt).toBe("2026-08-01T00:00:00Z");
  });
});

describe("publishContentItem", () => {
  it("rejects publishing a draft (#3148: no publish from draft)", async () => {
    const campId = useMarketerStore.getState().addCampaign("Launch week");
    const itemId = useMarketerStore.getState().addContentItem({ ...emailInput, campaignId: campId });
    const res = await useMarketerStore.getState().publishContentItem(itemId, "proj");
    expect(res.ok).toBe(false);
  });

  it("publishes an approved item, setting publishedAt + a receipt id (simulated when no backend)", async () => {
    const campId = useMarketerStore.getState().addCampaign("Launch week");
    const itemId = useMarketerStore.getState().addContentItem({ ...emailInput, campaignId: campId });
    useMarketerStore.getState().approveContentItem(itemId);
    const res = await useMarketerStore.getState().publishContentItem(itemId, "proj");
    expect(res.ok).toBe(true);
    const published = useMarketerStore.getState().contentItems[0];
    expect(published.status).toBe("published");
    expect(published.publishedAt).toBeTypeOf("number");
    expect(published.receiptId).toBeTruthy();
  });
});

describe("recordMetrics", () => {
  it("merges metrics onto the right content item", () => {
    const campId = useMarketerStore.getState().addCampaign("Launch week");
    const itemId = useMarketerStore.getState().addContentItem({ ...emailInput, campaignId: campId });
    useMarketerStore.getState().recordMetrics(itemId, { opens: 5 });
    useMarketerStore.getState().recordMetrics(itemId, { clicks: 2 });
    expect(useMarketerStore.getState().contentItems[0].metrics).toEqual({ opens: 5, clicks: 2 });
  });
});
