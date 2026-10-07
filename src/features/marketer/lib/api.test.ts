import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { dispatchContent, fetchChannelMetrics, fetchCampaigns, syncContentItem, syncCampaign } from "./api";
import { newContentItem, newCampaign } from "./campaign";

const item = newContentItem({ campaignId: "c1", channel: "Resend", channelKind: "email", body: "hi" }, "i1", 1000);
const campaign = newCampaign("Launch", "c1", 1000);

describe("marketing API bridge (contract-first, graceful degrade)", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("dispatchContent returns the receipt on success", async () => {
    vi.mocked(invoke).mockResolvedValue({ id: "send_email-1" });
    const r = await dispatchContent("proj", item);
    expect(r).toEqual({ id: "send_email-1" });
    expect(invoke).toHaveBeenCalledWith("marketing_publish_content", { project: "proj", contentItemId: "i1" });
  });

  it("dispatchContent returns null when the backend command isn't wired yet", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("command marketing_publish_content not found"));
    expect(await dispatchContent("proj", item)).toBeNull();
  });

  it("fetchChannelMetrics degrades to null on failure", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("not found"));
    expect(await fetchChannelMetrics("proj", "Resend")).toBeNull();
  });

  it("fetchChannelMetrics returns the readout on success", async () => {
    vi.mocked(invoke).mockResolvedValue({ total: 2, byTool: { send_email: 2 } });
    expect(await fetchChannelMetrics("proj", "Resend")).toEqual({ total: 2, byTool: { send_email: 2 } });
  });

  it("fetchCampaigns degrades to null (not []) so the caller can tell 'no backend' apart from 'empty'", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("not found"));
    expect(await fetchCampaigns("proj")).toBeNull();
  });

  it("syncContentItem / syncCampaign fire-and-forget without throwing even when the backend rejects", async () => {
    // .mockRejectedValueOnce twice — a fresh rejected promise per call, one per fireInvoke below
    // (mirrors safeInvoke.test.ts's convention; a shared mockRejectedValue promise can otherwise
    // surface as an unhandled rejection depending on how many callers observe the same instance).
    vi.mocked(invoke).mockRejectedValueOnce(new Error("not found")).mockRejectedValueOnce(new Error("not found"));
    expect(() => syncContentItem("proj", item)).not.toThrow();
    expect(() => syncCampaign("proj", campaign)).not.toThrow();
    expect(invoke).toHaveBeenCalledWith("marketing_upsert_content", { project: "proj", item });
    expect(invoke).toHaveBeenCalledWith("marketing_upsert_campaign", { project: "proj", campaign });
    // fireInvoke's rejection handling is async (its .catch runs on a later microtask) — let it settle
    // before the test ends, so the rejection is observed here rather than leaking as unhandled.
    await new Promise((r) => setTimeout(r, 0));
  });
});
