// API-tier LLM provider config (#1085) — the keys + provider/model that back llm_complete calls.
// Split from store/types (#1634).
import type { LlmProvider } from "@/shared/lib/core/llmConfig";

/** LLM-provider slice of {@link AppStore}. */
export interface LlmState {
  claudeApiKey: string;
  setClaudeApiKey: (key: string) => void;

  // API-tier LLM provider config (#1085) — powers llm_complete-backed calls (planning
  // autopilot, grader, cleanup verifier). `claudeApiKey` doubles as the anthropic key.
  // Distinct from the per-pane runtime model (defaultModel/paneModels).
  llmProvider: LlmProvider;
  setLlmProvider: (p: LlmProvider) => void;
  llmModel: string;
  setLlmModel: (m: string) => void;
  openaiKey: string;
  setOpenaiKey: (k: string) => void;
  geminiKey: string;
  setGeminiKey: (k: string) => void;
  /** OpenAI-compatible endpoint for the `local` provider (default Ollama). */
  localBaseUrl: string;
  setLocalBaseUrl: (u: string) => void;
}
