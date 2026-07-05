import { describe, it, expect } from "vitest";
import { registerProvider, getProvider, listProviders } from "./registry";
import type { ConsoleProvider } from "./types";

// Import index to trigger built-in provider registration
import "./index";

describe("provider registry", () => {
  it("getProvider returns undefined for an unknown id", () => {
    expect(getProvider("unknown-provider-xyz")).toBeUndefined();
  });

  it("registerProvider + getProvider round-trips a provider", () => {
    const p: ConsoleProvider = {
      id: "test-custom",
      displayName: "Test Custom",
      buildLaunchCmd: () => "test-cmd",
    };
    registerProvider(p);
    expect(getProvider("test-custom")).toBe(p);
  });

  it("listProviders includes all registered providers", () => {
    const ids = listProviders().map((p) => p.id);
    expect(ids).toContain("claude");
    expect(ids).toContain("gemini");
    expect(ids).toContain("codex");
    expect(ids).toContain("aider");
    expect(ids).toContain("ollama");
    expect(ids).toContain("amazonq");
    expect(ids).toContain("bsc-agent");
  });

  it("registerProvider overwrites an existing entry with the same id", () => {
    const original = getProvider("claude");
    const replacement: ConsoleProvider = { id: "claude", displayName: "Claude Replacement", buildLaunchCmd: () => "replaced" };
    registerProvider(replacement);
    expect(getProvider("claude")).toBe(replacement);
    // Restore
    if (original) registerProvider(original);
  });
});

describe("built-in Claude provider", () => {
  it("has isClaude = true", () => {
    const p = getProvider("claude");
    expect(p?.isClaude).toBe(true);
  });

  it("buildLaunchCmd returns 'claude' — parity with the hardcoded prior path", () => {
    const p = getProvider("claude");
    expect(p?.buildLaunchCmd()).toBe("claude");
  });

  it("has a prereqProbe", () => {
    const p = getProvider("claude");
    expect(p?.prereqProbe).toBeTruthy();
  });
});

describe("non-Claude built-in providers", () => {
  it.each(["gemini", "codex", "aider", "ollama", "amazonq"])("%s does not set isClaude", (id) => {
    const p = getProvider(id);
    expect(p).toBeDefined();
    expect(p?.isClaude).toBeFalsy();
  });

  it("gemini buildLaunchCmd returns 'gemini'", () => {
    expect(getProvider("gemini")?.buildLaunchCmd()).toBe("gemini");
  });

  it("codex buildLaunchCmd returns 'codex'", () => {
    expect(getProvider("codex")?.buildLaunchCmd()).toBe("codex");
  });

  it("aider buildLaunchCmd defaults to fleet-safe git (#1172) — auto-commit off", () => {
    // First-class Aider always disables auto-commit/dirty-commit so it never surprise-commits on a
    // pane's branch; the fleet's flow owns commits/PRs (full builder tested in aider.test.ts).
    const cmd = getProvider("aider")?.buildLaunchCmd();
    expect(cmd).toContain("aider");
    expect(cmd).toContain("--no-auto-commits");
    expect(cmd).toContain("--no-dirty-commits");
  });

  it("amazonq buildLaunchCmd returns 'q'", () => {
    expect(getProvider("amazonq")?.buildLaunchCmd()).toBe("q");
  });

  it("ollama uses default model when none supplied", () => {
    const cmd = getProvider("ollama")?.buildLaunchCmd();
    expect(cmd).toMatch(/^ollama run /);
  });

  it("ollama uses the supplied model", () => {
    const cmd = getProvider("ollama")?.buildLaunchCmd({ model: "mistral" });
    expect(cmd).toBe("ollama run mistral");
  });
});
