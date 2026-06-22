// API-tier LLM provider config (#1085 / epic #1078) — which provider + model + key
// powers kb_chat-backed (planning / assistant) calls: the planning autopilot, the
// LLM grader, the cleanup-scan verifier. This is DISTINCT from the per-pane runtime
// model (ModelId / defaultModel / paneModels → `claude --model`), which the harness
// adapter owns (P0/P2) — do not conflate them.

export type LlmProvider = "anthropic" | "openai" | "gemini" | "local";

export interface LlmConfig {
  provider: LlmProvider;
  model: string;
  apiKey: string;
}

/** The store fields `resolveLlmConfig` reads — a structural subset of the app store,
 *  so the resolver is unit-testable with a plain object. */
export interface LlmConfigSource {
  llmProvider: LlmProvider;
  llmModel: string;
  claudeApiKey: string;
  openaiKey: string;
  geminiKey: string;
}

/** Resolve the active provider + model and the API key for THAT provider.
 *  `local` (OpenAI-compatible, e.g. Ollama) needs no key. */
export function resolveLlmConfig(s: LlmConfigSource): LlmConfig {
  const apiKey =
    s.llmProvider === "openai" ? s.openaiKey :
    s.llmProvider === "gemini" ? s.geminiKey :
    s.llmProvider === "local"  ? "" :
    s.claudeApiKey;
  return { provider: s.llmProvider, model: s.llmModel, apiKey };
}

/** Whether the config can make a call — a key is present, or it's `local` (no key). */
export function hasLlmKey(cfg: LlmConfig): boolean {
  return cfg.provider === "local" || !!cfg.apiKey;
}
