import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { oneShotVision, providerSupportsVision } from "./claudeComplete";
import type { LlmConfig } from "./llmConfig";

const cfg = (over: Partial<LlmConfig> = {}): LlmConfig => ({
  provider: "anthropic", model: "claude-sonnet-4-6", apiKey: "sk-x", baseUrl: "", ...over,
});
const PNG = "data:image/png;base64,AAAA";

describe("oneShotVision (#2623 slice 5c — multimodal review call)", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("builds an Anthropic image block (source/base64) alongside the text", async () => {
    vi.mocked(invoke).mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const out = await oneShotVision(cfg(), "sys", "look", [PNG]);
    expect(out).toBe("ok");
    const [, args] = vi.mocked(invoke).mock.calls[0] as [string, { messages: { content: unknown[] }[] }];
    const content = args.messages[0].content;
    expect(content[0]).toEqual({ type: "text", text: "look" });
    expect(content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
  });

  it("builds an OpenAI image_url block from the raw data URL", async () => {
    vi.mocked(invoke).mockResolvedValue({ content: [{ type: "text", text: "" }] });
    await oneShotVision(cfg({ provider: "openai", apiKey: "sk-o" }), "sys", "look", [PNG]);
    const [, args] = vi.mocked(invoke).mock.calls[0] as [string, { messages: { content: unknown[] }[] }];
    expect(args.messages[0].content[1]).toEqual({ type: "image_url", image_url: { url: PNG } });
  });

  it("rejects a provider that can't take images before calling the model", async () => {
    await expect(oneShotVision(cfg({ provider: "gemini", apiKey: "k" }), "s", "u", [PNG])).rejects.toThrow(/Claude or OpenAI/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects when no key is configured", async () => {
    await expect(oneShotVision(cfg({ apiKey: "" }), "s", "u", [PNG])).rejects.toThrow(/No API key/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects a non-data-URL image", async () => {
    await expect(oneShotVision(cfg(), "s", "u", ["https://x/y.png"])).rejects.toThrow(/base64 data URL/);
  });

  it("providerSupportsVision covers anthropic + openai only", () => {
    expect(["anthropic", "openai", "gemini", "local", "ollama"].map((p) => providerSupportsVision(p as LlmConfig["provider"])))
      .toEqual([true, true, false, false, false]);
  });
});
