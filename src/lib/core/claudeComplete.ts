// One-shot Claude completion (#624) — a thin wrapper over the kb_chat Tauri command for
// features that need a single structured/short reply (the blueprint assistant's prose,
// the LLM grader, …) rather than a streaming session. Returns the concatenated text
// blocks; throws on no API key / network (callers fall back as appropriate).

import { invoke } from "@tauri-apps/api/core";

export async function oneShotComplete(apiKey: string, system: string, user: string): Promise<string> {
  if (!apiKey) throw new Error("No Claude API key configured.");
  const res = await invoke<{ content: { type: string; text?: string }[] }>("kb_chat", {
    messages: [{ role: "user", content: user }], system, tools: [], apiKey,
  });
  return (res.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim();
}
