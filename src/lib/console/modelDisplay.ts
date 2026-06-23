// Model display helpers (#1181) — turn the raw model id the Claude CLI records in its
// transcript (surfaced per pane by `read_token_usage`) into the two forms the console
// header needs: a compact label for the model pill, and the menu's selectable `ModelId`
// for the "currently running" highlight.

import type { ModelId } from "../../components/pane/PaneMenu";

/**
 * Map a transcript/CLI model id to the menu's selectable {@link ModelId}, when it belongs
 * to a Claude family the menu offers. Non-Claude models (gpt-*, gemini-*, local llama/qwen/…)
 * return `undefined` — the menu has no row to highlight for them.
 */
export function toModelId(raw?: string): ModelId | undefined {
  if (!raw) return undefined;
  const m = raw.toLowerCase();
  if (m.includes("opus")) return "opus-4.5";
  if (m.includes("sonnet")) return "sonnet-4.5";
  if (m.includes("haiku")) return "haiku-4.5";
  return undefined;
}

/**
 * A compact display label for the actually-running model, trimming a trailing release-date
 * suffix (`-20250930`) so the pill stays short. Returns `undefined` for a missing id so the
 * caller can fall back to the configured model.
 */
export function prettyModel(raw?: string): string | undefined {
  if (!raw) return undefined;
  return raw.replace(/-\d{8}$/, "");
}
