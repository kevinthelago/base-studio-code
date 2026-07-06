import { describe, it, expect } from "vitest";
import {
  resolveLlmConfig, hasLlmKey, bscAgentEnv, aiderModelArg, aiderEnv, providerNeedsBscAgent, effectiveHarness,
  resolveModel, modelOnProviderSwitch, DEFAULT_LOCAL_MODEL, DEFAULT_ANTHROPIC_MODEL, DEFAULT_LOCAL_BASE_URL,
  LLM_PROVIDERS,
  type LlmConfigSource,
} from "./llmConfig";

// #2416: the model-ID defaults + provider list moved to `@data/console/model-defaults.json` — the
// ONE source for every model default. Pin that they resolve to the previous TS-authored values.
describe("model defaults resolve from @data/console/model-defaults.json (#2416)", () => {
  it("keeps the previous packaged defaults", () => {
    expect(DEFAULT_ANTHROPIC_MODEL).toBe("claude-sonnet-4-6");
    expect(DEFAULT_LOCAL_MODEL).toBe("qwen3-coder");
    expect(DEFAULT_LOCAL_BASE_URL).toBe("http://localhost:11434/v1");
  });

  it("keeps the previous provider list + key placeholders, in order", () => {
    expect(LLM_PROVIDERS.map((p) => [p.id, p.label])).toEqual([
      ["anthropic", "Anthropic Claude"],
      ["openai",    "OpenAI"],
      ["gemini",    "Google Gemini"],
      ["local",     "Local (Ollama / OpenAI-compatible)"],
      ["ollama",    "Ollama (Local)"],
    ]);
    expect(Object.fromEntries(LLM_PROVIDERS.map((p) => [p.id, p.keyPlaceholder]))).toEqual({
      anthropic: "sk-ant-…", openai: "sk-…", gemini: "AIza…", local: "", ollama: "",
    });
  });
});

const base: LlmConfigSource = {
  llmProvider: "anthropic",
  llmModel: "claude-sonnet-4-6",
  claudeApiKey: "ant-key",
  openaiKey: "oai-key",
  geminiKey: "gem-key",
  localBaseUrl: "http://localhost:11434/v1",
};

describe("resolveLlmConfig (#1085)", () => {
  it("picks the anthropic key + model for anthropic", () => {
    expect(resolveLlmConfig(base)).toEqual({
      provider: "anthropic", model: "claude-sonnet-4-6", apiKey: "ant-key",
      baseUrl: "http://localhost:11434/v1",
    });
  });

  it("carries the configured local base URL (#1091)", () => {
    expect(resolveLlmConfig({ ...base, llmProvider: "local", localBaseUrl: "http://10.0.0.5:8080/v1" }).baseUrl)
      .toBe("http://10.0.0.5:8080/v1");
  });

  it("picks the per-provider key", () => {
    expect(resolveLlmConfig({ ...base, llmProvider: "openai" }).apiKey).toBe("oai-key");
    expect(resolveLlmConfig({ ...base, llmProvider: "gemini" }).apiKey).toBe("gem-key");
  });

  it("returns no key for local / ollama", () => {
    expect(resolveLlmConfig({ ...base, llmProvider: "local" }).apiKey).toBe("");
    expect(resolveLlmConfig({ ...base, llmProvider: "ollama" }).apiKey).toBe("");
  });

  it("carries the configured model", () => {
    expect(resolveLlmConfig({ ...base, llmProvider: "openai", llmModel: "gpt-5" }).model).toBe("gpt-5");
  });

  it("substitutes the local default when ollama still holds a stale claude model (#404 fix)", () => {
    // The bug: provider switched to ollama but llmModel left at the anthropic default → 404 on Ollama.
    expect(resolveLlmConfig({ ...base, llmProvider: "ollama" }).model).toBe(DEFAULT_LOCAL_MODEL);
    expect(resolveLlmConfig({ ...base, llmProvider: "local", llmModel: "" }).model).toBe(DEFAULT_LOCAL_MODEL);
    // A real local model the user typed is kept.
    expect(resolveLlmConfig({ ...base, llmProvider: "ollama", llmModel: "llama3.1" }).model).toBe("llama3.1");
  });
});

describe("resolveModel / modelOnProviderSwitch", () => {
  it("resolveModel swaps empty/claude models only for local providers", () => {
    expect(resolveModel("ollama", "claude-sonnet-4-6")).toBe(DEFAULT_LOCAL_MODEL);
    expect(resolveModel("local", "")).toBe(DEFAULT_LOCAL_MODEL);
    expect(resolveModel("ollama", "qwen3-coder")).toBe("qwen3-coder"); // custom kept
    expect(resolveModel("anthropic", "claude-sonnet-4-6")).toBe("claude-sonnet-4-6"); // hosted untouched
    expect(resolveModel("openai", "")).toBe(""); // hosted untouched
  });

  it("modelOnProviderSwitch defaults to qwen3-coder for ollama and restores claude for hosted", () => {
    expect(modelOnProviderSwitch("ollama", "claude-sonnet-4-6")).toBe(DEFAULT_LOCAL_MODEL);
    expect(modelOnProviderSwitch("ollama", "")).toBe(DEFAULT_LOCAL_MODEL);
    expect(modelOnProviderSwitch("ollama", "llama3.1")).toBe("llama3.1"); // custom kept
    // Switching back: a leftover local default reverts to the anthropic default.
    expect(modelOnProviderSwitch("anthropic", DEFAULT_LOCAL_MODEL)).toBe("claude-sonnet-4-6");
    expect(modelOnProviderSwitch("openai", "gpt-5")).toBe("gpt-5"); // custom kept
  });
});

describe("hasLlmKey", () => {
  it("is true when a key is present", () => {
    expect(hasLlmKey({ provider: "openai", model: "gpt-5", apiKey: "x", baseUrl: "" })).toBe(true);
  });
  it("is false when a cloud provider has no key", () => {
    expect(hasLlmKey({ provider: "anthropic", model: "m", apiKey: "", baseUrl: "" })).toBe(false);
  });
  it("is true for local / ollama even without a key", () => {
    expect(hasLlmKey({ provider: "local", model: "llama3", apiKey: "", baseUrl: "" })).toBe(true);
    expect(hasLlmKey({ provider: "ollama", model: "llama3", apiKey: "", baseUrl: "" })).toBe(true);
  });
});

describe("providerNeedsBscAgent / effectiveHarness", () => {
  it("flags local + ollama as needing bsc-agent (Claude Code can't drive them)", () => {
    expect(providerNeedsBscAgent("local")).toBe(true);
    expect(providerNeedsBscAgent("ollama")).toBe(true);
    expect(providerNeedsBscAgent("anthropic")).toBe(false);
    expect(providerNeedsBscAgent("openai")).toBe(false);
    expect(providerNeedsBscAgent("gemini")).toBe(false);
  });

  it("forces bsc-agent for a local/ollama provider regardless of the toggle", () => {
    expect(effectiveHarness("ollama", "claude")).toBe("bsc-agent");
    expect(effectiveHarness("ollama", "bsc-agent")).toBe("bsc-agent");
    expect(effectiveHarness("local", "claude")).toBe("bsc-agent");
  });

  it("honors the explicit toggle for providers Claude Code can run", () => {
    expect(effectiveHarness("anthropic", "claude")).toBe("claude");
    expect(effectiveHarness("anthropic", "bsc-agent")).toBe("bsc-agent");
    expect(effectiveHarness("openai", "claude")).toBe("claude");
    expect(effectiveHarness("gemini", "bsc-agent")).toBe("bsc-agent");
  });
});

describe("bscAgentEnv", () => {
  it("always carries provider + model + key when set", () => {
    const e = bscAgentEnv({ provider: "openai", model: "gpt-5", apiKey: "k", baseUrl: "" });
    expect(e.BSC_AGENT_PROVIDER).toBe("openai");
    expect(e.BSC_AGENT_MODEL).toBe("gpt-5");
    expect(e.BSC_AGENT_API_KEY).toBe("k");
    expect(e.BSC_AGENT_BASE_URL).toBeUndefined();
  });
  it("omits the key for local (none) and carries the base URL", () => {
    const e = bscAgentEnv({ provider: "local", model: "llama3", apiKey: "", baseUrl: "http://localhost:11434/v1" });
    expect(e.BSC_AGENT_API_KEY).toBeUndefined();
    expect(e.BSC_AGENT_BASE_URL).toBe("http://localhost:11434/v1");
  });
});

describe("aiderModelArg (#1172)", () => {
  it("namespaces anthropic + gemini models by provider", () => {
    expect(aiderModelArg({ provider: "anthropic", model: "claude-sonnet-4-6", apiKey: "k", baseUrl: "" })).toBe("anthropic/claude-sonnet-4-6");
    expect(aiderModelArg({ provider: "gemini", model: "gemini-2.0-flash", apiKey: "k", baseUrl: "" })).toBe("gemini/gemini-2.0-flash");
  });
  it("passes OpenAI models bare", () => {
    expect(aiderModelArg({ provider: "openai", model: "gpt-4o", apiKey: "k", baseUrl: "" })).toBe("gpt-4o");
  });
  it("routes a local / ollama model through the openai/ prefix (OpenAI-compatible endpoint)", () => {
    expect(aiderModelArg({ provider: "local", model: "qwen3-coder", apiKey: "", baseUrl: "http://x/v1" })).toBe("openai/qwen3-coder");
    expect(aiderModelArg({ provider: "ollama", model: "llama3", apiKey: "", baseUrl: "http://x/v1" })).toBe("openai/llama3");
  });
  it("leaves a model that already carries a provider/ prefix untouched", () => {
    expect(aiderModelArg({ provider: "anthropic", model: "anthropic/claude-3-5-sonnet", apiKey: "k", baseUrl: "" })).toBe("anthropic/claude-3-5-sonnet");
  });
});

describe("aiderEnv (#1172)", () => {
  it("maps each hosted provider's key to the var Aider/litellm reads", () => {
    expect(aiderEnv({ provider: "anthropic", model: "m", apiKey: "ant", baseUrl: "" })).toEqual({ ANTHROPIC_API_KEY: "ant" });
    expect(aiderEnv({ provider: "openai", model: "m", apiKey: "oai", baseUrl: "" })).toEqual({ OPENAI_API_KEY: "oai" });
    expect(aiderEnv({ provider: "gemini", model: "m", apiKey: "gem", baseUrl: "" })).toEqual({ GEMINI_API_KEY: "gem" });
  });
  it("omits a hosted key when none is set", () => {
    expect(aiderEnv({ provider: "anthropic", model: "m", apiKey: "", baseUrl: "" })).toEqual({});
  });
  it("carries OPENAI_API_BASE + a placeholder key for a local / ollama endpoint", () => {
    const e = aiderEnv({ provider: "local", model: "m", apiKey: "", baseUrl: "http://localhost:11434/v1" });
    expect(e.OPENAI_API_BASE).toBe("http://localhost:11434/v1");
    expect(e.OPENAI_API_KEY).toBe("sk-local-none"); // non-empty so the client inits
  });
});
