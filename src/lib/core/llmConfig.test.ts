import { describe, it, expect } from "vitest";
import { resolveLlmConfig, hasLlmKey, type LlmConfigSource } from "./llmConfig";

const base: LlmConfigSource = {
  llmProvider: "anthropic",
  llmModel: "claude-sonnet-4-6",
  claudeApiKey: "ant-key",
  openaiKey: "oai-key",
  geminiKey: "gem-key",
};

describe("resolveLlmConfig (#1085)", () => {
  it("picks the anthropic key + model for anthropic", () => {
    expect(resolveLlmConfig(base)).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6", apiKey: "ant-key" });
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
    expect(hasLlmKey({ provider: "openai", model: "gpt-5", apiKey: "x" })).toBe(true);
  });
  it("is false when a cloud provider has no key", () => {
    expect(hasLlmKey({ provider: "anthropic", model: "m", apiKey: "" })).toBe(false);
  });
  it("is true for local even without a key", () => {
    expect(hasLlmKey({ provider: "local", model: "llama3", apiKey: "" })).toBe(true);
  });
});
