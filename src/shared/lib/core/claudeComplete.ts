// One-shot LLM completion (#624; provider-agnostic since #1085) — a thin wrapper over
// the llm_complete Tauri command for features that need a single structured/short reply
// (the blueprint assistant's prose, the LLM grader, the cleanup verifier, the preview
// reviewer, …) rather than a streaming session. Routed through the active LlmConfig
// (provider + model + key), so it works on any provider. Returns the concatenated text
// blocks; throws on missing key / network (callers fall back as appropriate).

import { invoke } from "@tauri-apps/api/core";
import { type LlmConfig, hasLlmKey } from "./llmConfig";

interface LlmReply { content: { type: string; text?: string }[] }

/** Join the text blocks of an llm_complete reply into one trimmed string. */
function replyText(res: LlmReply): string {
  return (res.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim();
}

export async function oneShotComplete(cfg: LlmConfig, system: string, user: string): Promise<string> {
  if (!hasLlmKey(cfg)) throw new Error(`No API key configured for ${cfg.provider}. Add it in Settings → Integrations.`);
  const res = await invoke<LlmReply>("llm_complete", {
    messages: [{ role: "user", content: user }], system, tools: [],
    apiKey: cfg.apiKey, provider: cfg.provider, model: cfg.model, baseUrl: cfg.baseUrl,
  });
  return replyText(res);
}

/** A captured image to send with a vision prompt — a `data:<mime>;base64,<…>` URL. */
export type ImageDataUrl = string;

/** Providers whose Messages API accepts image content blocks in the shape we build below. Claude Code
 *  only ever speaks Anthropic; OpenAI's chat API takes `image_url`. Gemini/local use different shapes we
 *  don't build here, so vision falls back to a clear error rather than silently dropping the image. */
export function providerSupportsVision(p: LlmConfig["provider"]): boolean {
  return p === "anthropic" || p === "openai";
}

/** Split a `data:<mime>;base64,<data>` URL into its media type + base64 payload. */
function splitDataUrl(url: ImageDataUrl): { mediaType: string; data: string } {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (!m) throw new Error("vision image must be a base64 data URL");
  return { mediaType: m[1], data: m[2] };
}

/** Build the provider-specific `content` array (a text block + one block per image) for a vision message.
 *  Anthropic → `{type:"image",source:{type:"base64",…}}`; OpenAI → `{type:"image_url",image_url:{url}}`. */
function visionContent(provider: LlmConfig["provider"], text: string, images: ImageDataUrl[]): unknown[] {
  const blocks: unknown[] = [{ type: "text", text }];
  for (const url of images) {
    if (provider === "openai") {
      blocks.push({ type: "image_url", image_url: { url } });
    } else {
      const { mediaType, data } = splitDataUrl(url);
      blocks.push({ type: "image", source: { type: "base64", media_type: mediaType, data } });
    }
  }
  return blocks;
}

/**
 * One-shot MULTIMODAL completion — `text` plus one or more screenshots, for the preview reviewer (#2623)
 * and any future see-the-screen feature. Builds provider-appropriate image content blocks and sends them
 * through the same `llm_complete` path (which forwards `messages` verbatim to the provider's API).
 * @throws when no key is configured, or the active provider can't take images (see {@link providerSupportsVision}).
 */
export async function oneShotVision(
  cfg: LlmConfig,
  system: string,
  text: string,
  images: ImageDataUrl[],
): Promise<string> {
  if (!hasLlmKey(cfg)) throw new Error(`No API key configured for ${cfg.provider}. Add it in Settings → Integrations.`);
  if (!providerSupportsVision(cfg.provider)) {
    throw new Error(`Image review needs Claude or OpenAI — ${cfg.provider} can't read screenshots. Switch provider in Settings → Integrations.`);
  }
  const res = await invoke<LlmReply>("llm_complete", {
    messages: [{ role: "user", content: visionContent(cfg.provider, text, images) }], system, tools: [],
    apiKey: cfg.apiKey, provider: cfg.provider, model: cfg.model, baseUrl: cfg.baseUrl,
  });
  return replyText(res);
}
