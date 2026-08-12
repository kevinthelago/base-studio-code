import { describe, it, expect } from "vitest";
import { summarizeMetrics, fmtMetric, fmtChannelReadout } from "./metrics";
import { newContentItem, type ContentItem } from "./campaign";

function published(over: Partial<ContentItem> = {}): ContentItem {
  return {
    ...newContentItem({ campaignId: "c1", channel: "Resend", channelKind: "email", body: "hi" }, over.id ?? "i1", 1000),
    status: "published",
    ...over,
  };
}

describe("summarizeMetrics", () => {
  it("counts published items and sums their metrics", () => {
    const items = [
      published({ id: "a", metrics: { opens: 10, clicks: 2 } }),
      published({ id: "b", metrics: { opens: 5, impressions: 100 } }),
      newContentItem({ campaignId: "c1", channel: "Resend", channelKind: "email", body: "draft" }, "d", 1000), // still draft
    ];
    expect(summarizeMetrics(items)).toEqual({ published: 2, opens: 15, clicks: 2, impressions: 100 });
  });

  it("degrades gracefully with no metrics at all (#3149)", () => {
    expect(summarizeMetrics([])).toEqual({ published: 0, opens: 0, clicks: 0, impressions: 0 });
  });
});

describe("fmtMetric", () => {
  it("shows an em-dash for missing/zero, and a localized number otherwise", () => {
    expect(fmtMetric(undefined)).toBe("—");
    expect(fmtMetric(0)).toBe("—");
    expect(fmtMetric(1234)).toBe((1234).toLocaleString());
  });
});

describe("fmtChannelReadout", () => {
  it("reports 'no sends yet' for a null or empty readout", () => {
    expect(fmtChannelReadout(null)).toBe("no sends yet");
    expect(fmtChannelReadout({ total: 0, byTool: {} })).toBe("no sends yet");
  });

  it("formats the total + per-tool breakdown", () => {
    expect(fmtChannelReadout({ total: 3, byTool: { send_email: 2, post: 1 } })).toBe("3 sent · 2 send_email · 1 post");
  });
});
