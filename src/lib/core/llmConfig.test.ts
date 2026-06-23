import { describe, it, expect } from "vitest";
import { resolveLlmConfig, hasLlmKey, bscAgentEnv, type LlmConfigSource } from "./llmConfig";

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

  it("returns no key for local", () => {
    expect(resolveLlmConfig({ ...base, llmProvider: "local" }).apiKey).toBe("");
  });

  it("carries the configured model", () => {
    expect(resolveLlmConfig({ ...base, llmProvider: "openai", llmModel: "gpt-5" }).model).toBe("gpt-5");
  });
});

describe("hasLlmKey", () => {
  it("is true when a key is present", () => {
    expect(hasLlmKey({ provider: "openai", model: "gpt-5", apiKey: "x", baseUrl: "" })).toBe(true);
  });
  it("is false when a cloud provider has no key", () => {
    expect(hasLlmKey({ provider: "anthropic", model: "m", apiKey: "", baseUrl: "" })).toBe(false);
  });
  it("is true for local even without a key", () => {
    expect(hasLlmKey({ provider: "local", model: "llama3", apiKey: "", baseUrl: "" })).toBe(true);
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
