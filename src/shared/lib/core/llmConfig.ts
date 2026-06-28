// API-tier LLM provider config (#1085 / epic #1078) — which provider + model + key
// powers llm_complete-backed (planning / assistant) calls: the planning autopilot, the
// LLM grader, the cleanup-scan verifier. This is DISTINCT from the per-pane runtime
// model (ModelId / defaultModel / paneModels → `claude --model`), which the harness
// adapter owns (P0/P2) — do not conflate them.

export type LlmProvider = "anthropic" | "openai" | "gemini" | "local" | "ollama";

export interface LlmConfig {
  provider: LlmProvider;
  model: string;
  apiKey: string;
  /** OpenAI-compatible endpoint for the `local` / `ollama` provider (ignored by hosted ones). */
  baseUrl: string;
}

/** The store fields `resolveLlmConfig` reads — a structural subset of the app store,
 *  so the resolver is unit-testable with a plain object. */
export interface LlmConfigSource {
  llmProvider: LlmProvider;
  llmModel: string;
  claudeApiKey: string;
  openaiKey: string;
  geminiKey: string;
  localBaseUrl: string;
}

/** Default model for a local runtime (Ollama / OpenAI-compatible). A hosted `claude-*` model can
 *  never run locally, so a local provider falls back to this. (`ollama run qwen3-coder`.) */
export const DEFAULT_LOCAL_MODEL = "qwen3-coder";
/** The packaged Anthropic default, restored when switching back to a hosted provider. */
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";

/** The model to actually send for a config. A `local`/`ollama` provider substitutes
 *  {@link DEFAULT_LOCAL_MODEL} when the stored model is empty or a hosted `claude-*` model (which
 *  404s on Ollama), so a stale Anthropic default never reaches the local runtime. */
export function resolveModel(provider: LlmProvider, model: string): string {
  if (providerNeedsBscAgent(provider) && (model.trim() === "" || /^claude/i.test(model))) {
    return DEFAULT_LOCAL_MODEL;
  }
  return model;
}

/** The model-field value after the user switches provider — keeps the field runnable on the new
 *  provider without clobbering a model the user explicitly typed:
 *   • → local/ollama: use {@link DEFAULT_LOCAL_MODEL} when the field is empty or a hosted `claude-*`.
 *   • → a hosted provider: restore {@link DEFAULT_ANTHROPIC_MODEL} when the field is empty or still
 *     holds the local default. Any other (custom) model is preserved as-is. */
export function modelOnProviderSwitch(provider: LlmProvider, currentModel: string): string {
  const m = currentModel.trim();
  if (providerNeedsBscAgent(provider)) {
    return m === "" || /^claude/i.test(m) ? DEFAULT_LOCAL_MODEL : currentModel;
  }
  return m === "" || m === DEFAULT_LOCAL_MODEL ? DEFAULT_ANTHROPIC_MODEL : currentModel;
}

/** Resolve the active provider + model and the API key for THAT provider.
 *  `local` & `ollama` (OpenAI-compatible, e.g. Ollama) need no key but carry a base URL. */
export function resolveLlmConfig(s: LlmConfigSource): LlmConfig {
  const apiKey =
    s.llmProvider === "openai" ? s.openaiKey :
    s.llmProvider === "gemini" ? s.geminiKey :
    (s.llmProvider === "local" || s.llmProvider === "ollama") ? "" :
    s.claudeApiKey;
  return {
    provider: s.llmProvider,
    model: resolveModel(s.llmProvider, s.llmModel),
    apiKey,
    baseUrl: s.localBaseUrl,
  };
}

/** Whether the config can make a call — a key is present, or it's `local`/`ollama` (no key). */
export function hasLlmKey(cfg: LlmConfig): boolean {
  return cfg.provider === "local" || cfg.provider === "ollama" || !!cfg.apiKey;
}

/** Providers Claude Code (the `claude` CLI) cannot drive — it only ever speaks to Anthropic. A
 *  SESSION (planner / worker / director) on one of these MUST run on the `bsc-agent` harness, so
 *  picking it implies bsc-agent regardless of the fleet-harness toggle. */
export function providerNeedsBscAgent(p: LlmProvider): boolean {
  return p === "local" || p === "ollama";
}

/** The harness a session should actually launch on. A provider Claude Code can't run (`local` /
 *  `ollama`) forces `bsc-agent` — otherwise selecting Ollama would silently launch Claude Code and
 *  ignore the choice. Every other provider honors the user's explicit `fleetHarness` toggle. So
 *  setting the provider to Ollama runs the planner, workers, and directors on Ollama with no second
 *  switch to flip. */
export function effectiveHarness(
  provider: LlmProvider,
  fleetHarness: "claude" | "bsc-agent",
): "claude" | "bsc-agent" {
  return providerNeedsBscAgent(provider) ? "bsc-agent" : fleetHarness;
}

/** The `BSC_AGENT_*` env a bsc-agent session needs to reach the configured LLM (#1078 P3b).
 *  The runtime reads provider/model/key (+ base URL for `local`/`ollama`) from these. */
export function bscAgentEnv(cfg: LlmConfig): Record<string, string> {
  const e: Record<string, string> = {
    BSC_AGENT_PROVIDER: cfg.provider,
    BSC_AGENT_MODEL: cfg.model,
  };
  if (cfg.apiKey) e.BSC_AGENT_API_KEY = cfg.apiKey;
  if (cfg.baseUrl) e.BSC_AGENT_BASE_URL = cfg.baseUrl;
  return e;
}
