// LlmSettingsSlice — the API-tier LLM provider config (#1085): the anthropic/openai/gemini keys,
// the local endpoint, and the provider/model that back llm_complete calls. Split out of the former
// `core` grab-bag (#2715) — these are settings, not project state. Typed Pick<AppStore, …>.
import type { StateCreator } from "zustand";
import type { AppStore } from "../types";
import { modelOnProviderSwitch, DEFAULT_ANTHROPIC_MODEL, DEFAULT_LOCAL_BASE_URL } from "@/shared/lib/core/llmConfig";

type LlmSettingsSlice = Pick<AppStore,
  "claudeApiKey" | "setClaudeApiKey" | "llmProvider" | "setLlmProvider" | "llmModel" | "setLlmModel" | "openaiKey" | "setOpenaiKey" | "geminiKey" | "setGeminiKey" | "localBaseUrl" | "setLocalBaseUrl"
>;

export const createLlmSettingsSlice: StateCreator<AppStore, [], [], LlmSettingsSlice> = (set) => ({
      claudeApiKey: "",
      setClaudeApiKey: (key) => set({ claudeApiKey: key }),

      // API-tier LLM provider config (#1085). claudeApiKey is the anthropic key.
      llmProvider: "anthropic",
      // Switch the model field to the new provider's default when it still holds another provider's
      // default (a hosted `claude-*` model can't run on Ollama, and vice-versa) — a model the user
      // typed is preserved. So picking Ollama lands on `qwen3-coder` instead of a 404 on the Claude id.
      setLlmProvider: (p) => set((s) => ({ llmProvider: p, llmModel: modelOnProviderSwitch(p, s.llmModel) })),
      llmModel: DEFAULT_ANTHROPIC_MODEL,
      setLlmModel: (m) => set({ llmModel: m }),
      openaiKey: "",
      setOpenaiKey: (k) => set({ openaiKey: k }),
      geminiKey: "",
      setGeminiKey: (k) => set({ geminiKey: k }),
      localBaseUrl: DEFAULT_LOCAL_BASE_URL,
      setLocalBaseUrl: (u) => set({ localBaseUrl: u }),
});
