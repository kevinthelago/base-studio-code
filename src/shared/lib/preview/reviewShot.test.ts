import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { reviewShot } from "./reviewShot";
import type { PreviewShot } from "./previewReview";
import type { LlmConfig } from "@/shared/lib/core/llmConfig";

const cfg: LlmConfig = { provider: "anthropic", model: "claude-sonnet-4-6", apiKey: "sk-x", baseUrl: "" };
const shot: PreviewShot = { id: "s1", label: "Dashboard", image: "data:image/png;base64,AAAA" };

const reply = (text: string) => ({ content: [{ type: "text", text }] });

describe("reviewShot (#2623 slice 5c — shot → findings)", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("sends the shot image and parses the model's findings, tagged with the shot id", async () => {
    vi.mocked(invoke).mockResolvedValue(reply('[{"severity":"issue","title":"Overlap","detail":"Fix gap."}]'));
    const findings = await reviewShot(cfg, shot);
    expect(findings).toEqual([
      { id: "s1:0:0", shotId: "s1", severity: "issue", title: "Overlap", detail: "Fix gap.", status: "pending" },
    ]);
    // the screenshot was actually attached to the call
    const [, args] = vi.mocked(invoke).mock.calls[0] as [string, { messages: { content: { type: string }[] }[] }];
    expect(args.messages[0].content.some((b) => b.type === "image")).toBe(true);
  });

  it("returns [] for a good screen (empty array) without throwing", async () => {
    vi.mocked(invoke).mockResolvedValue(reply("[]"));
    expect(await reviewShot(cfg, shot)).toEqual([]);
  });

  it("returns [] for an unparseable reply (tolerant) rather than crashing the loop", async () => {
    vi.mocked(invoke).mockResolvedValue(reply("the screen looks fine to me"));
    expect(await reviewShot(cfg, shot)).toEqual([]);
  });

  it("threads the seq discriminator into the minted ids", async () => {
    vi.mocked(invoke).mockResolvedValue(reply('[{"title":"A"},{"title":"B"}]'));
    const findings = await reviewShot(cfg, shot, 3);
    expect(findings.map((f) => f.id)).toEqual(["s1:3:0", "s1:3:1"]);
  });

  it("propagates a call failure (no key / provider / network)", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("network down"));
    await expect(reviewShot(cfg, shot)).rejects.toThrow(/network down/);
  });
});
