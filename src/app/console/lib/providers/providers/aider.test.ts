import { describe, it, expect } from "vitest";
import { aiderProvider, buildAiderCommand, aiderFirstRunInstall } from "./aider";
import type { LlmConfig } from "@/shared/lib/core/llmConfig";

const anthropic: LlmConfig = { provider: "anthropic", model: "claude-sonnet-4-6", apiKey: "k", baseUrl: "" };

describe("buildAiderCommand — fleet-safe git (#1172)", () => {
  it("ALWAYS disables auto-commits + dirty-commits, even with no config", () => {
    const cmd = buildAiderCommand();
    expect(cmd).toContain("--no-auto-commits");
    expect(cmd).toContain("--no-dirty-commits");
  });

  it("never emits a push flag — the fleet's flow owns git push (#297/#1948)", () => {
    expect(buildAiderCommand({ llm: anthropic, startupPrompt: "go" })).not.toMatch(/push/);
  });
});

describe("buildAiderCommand — LLM config (#1172)", () => {
  it("maps the resolved LLM config to Aider's namespaced --model", () => {
    expect(buildAiderCommand({ llm: anthropic })).toContain("--model 'anthropic/claude-sonnet-4-6'");
  });

  it("honors a bare model string when no llm config is present", () => {
    expect(buildAiderCommand({ model: "gpt-4o" })).toContain("--model 'gpt-4o'");
  });

  it("omits --model entirely when neither is given (Aider's own default)", () => {
    expect(buildAiderCommand()).not.toContain("--model");
  });
});

describe("buildAiderCommand — task delivery + worker context (#1172)", () => {
  it("delivers the startup prompt via --message, single-quoted", () => {
    expect(buildAiderCommand({ startupPrompt: "implement #42" })).toContain("--message 'implement #42'");
  });

  it("escapes single quotes in the prompt so the shell command stays valid", () => {
    // POSIX '…' escaping: a literal ' becomes '\'' .
    expect(buildAiderCommand({ startupPrompt: "don't stop" })).toContain(String.raw`--message 'don'\''t stop'`);
  });

  it("preserves a multi-line prompt inside the single quotes", () => {
    const cmd = buildAiderCommand({ startupPrompt: "line1\nline2" });
    expect(cmd).toContain("--message 'line1\nline2'");
  });

  it("loads each worker-context file read-only via --read", () => {
    const cmd = buildAiderCommand({ readFiles: ["CLAUDE.local.md"] });
    expect(cmd).toContain("--read 'CLAUDE.local.md'");
  });

  it("composes model + read + message together, after the fleet-safe flags", () => {
    const cmd = buildAiderCommand({ llm: anthropic, readFiles: ["CLAUDE.local.md"], startupPrompt: "go" });
    expect(cmd).toBe(
      "aider --no-auto-commits --no-dirty-commits --model 'anthropic/claude-sonnet-4-6' --read 'CLAUDE.local.md' --message 'go'",
    );
  });
});

describe("aiderProvider metadata (#1172)", () => {
  it("wires buildAiderCommand as its launch builder", () => {
    expect(aiderProvider.buildLaunchCmd).toBe(buildAiderCommand);
    expect(aiderProvider.id).toBe("aider");
  });

  it("is NOT a Claude/harness provider (bare-CLI launch)", () => {
    expect(aiderProvider.isClaude).toBeFalsy();
  });

  it("flags its limitations (no permission gate, no MCP, limited telemetry)", () => {
    expect(aiderProvider.limitations?.length).toBeGreaterThan(0);
    expect(aiderProvider.limitations?.join(" ")).toMatch(/permission gate/i);
    expect(aiderProvider.limitations?.join(" ")).toMatch(/MCP/i);
    expect(aiderProvider.limitations?.join(" ")).toMatch(/telemetry/i);
  });

  it("carries a pip first-run install descriptor (not npm)", () => {
    expect(aiderFirstRunInstall.command).toContain("pip install aider-chat");
    expect(aiderProvider.firstRunInstall).toBe(aiderFirstRunInstall);
    expect(aiderProvider.prereqProbe).toBe("which aider");
  });
});
