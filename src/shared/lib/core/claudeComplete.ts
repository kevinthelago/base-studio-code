// One-shot LLM completion (#624; provider-agnostic since #1085) — a thin wrapper over
// the llm_complete Tauri command for features that need a single structured/short reply
// (the blueprint assistant's prose, the LLM grader, the cleanup verifier, …) rather
// than a streaming session. Routed through the active LlmConfig (provider + model +
// key), so it works on any provider. Returns the concatenated text blocks; throws on
// missing key / network (callers fall back as appropriate).

import { invoke } from "@tauri-apps/api/core";
import { type LlmConfig, hasLlmKey } from "./llmConfig";

export async function oneShotComplete(cfg: LlmConfig, system: string, user: string): Promise<string> {
  if (!hasLlmKey(cfg)) throw new Error(`No API key configured for ${cfg.provider}. Add it in Settings → Integrations.`);
  const res = await invoke<{ content: { type: string; text?: string }[] }>("llm_complete", {
    messages: [{ role: "user", content: user }], system, tools: [],
    apiKey: cfg.apiKey, provider: cfg.provider, model: cfg.model, baseUrl: cfg.baseUrl,
  });
  return (res.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim();
}
