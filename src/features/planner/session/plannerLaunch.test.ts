import { describe, it, expect } from "vitest";
import { plannerLaunchConfig } from "./plannerLaunch";
import type { AppStore } from "@/store/types";

// Minimal store snapshot — plannerLaunchConfig reads only the LLM-config + harness + MCP fields.
function store(over: Partial<AppStore>): AppStore {
  return {
    llmProvider: "anthropic",
    llmModel: "claude-sonnet-4-6",
    claudeApiKey: "ant-key",
    openaiKey: "",
    geminiKey: "",
    localBaseUrl: "http://localhost:11434/v1",
    fleetHarness: "claude",
    mcpServers: [],
    ...over,
  } as unknown as AppStore;
}

const GH = { GH_TOKEN: "t", GITHUB_TOKEN: "t" };

describe("plannerLaunchConfig", () => {
  it("launches Claude Code for anthropic + the default harness", () => {
    const l = plannerLaunchConfig(store({}), GH);
    expect(l.providerId).toBeUndefined();
    expect(l.initCmd).toContain("claude");
    expect(l.startupPromptFreshOnly).toBe(true);
    // Defensive (#2396): resume is requested explicitly; the backend ANDs it with real history.
    expect(l.continueSession).toBe(true);
    // No BSC_AGENT_* env for a Claude planner — just the GH tokens + the store-scope doc (#2470).
    expect(l.env).toEqual({ ...GH, BSC_SCOPES: JSON.stringify({ ui: "read" }) });
  });

  it("carries the planner's BSC_SCOPES store-scope doc on both harnesses (#2470)", () => {
    // The runtime write check the store CLIs read: the planner may USE the component kit (`bsc ui`
    // reads) but its mutating verbs refuse — on Claude and on the bsc-agent runtime alike.
    const claude = plannerLaunchConfig(store({}), GH);
    expect(JSON.parse(claude.env.BSC_SCOPES)).toEqual({ ui: "read" });
    const agent = plannerLaunchConfig(store({ llmProvider: "ollama" }), GH);
    expect(JSON.parse(agent.env.BSC_SCOPES)).toEqual({ ui: "read" });
  });

  it("runs the planner on bsc-agent + Ollama when the provider is ollama (no second toggle)", () => {
    const l = plannerLaunchConfig(store({ llmProvider: "ollama", llmModel: "llama3", fleetHarness: "claude" }), GH);
    expect(l.providerId).toBe("bsc-agent");
    expect(l.env.BSC_AGENT_PROVIDER).toBe("ollama");
    expect(l.env.BSC_AGENT_MODEL).toBe("llama3");
    expect(l.env.BSC_AGENT_BASE_URL).toBe("http://localhost:11434/v1");
    expect(l.env.GH_TOKEN).toBe("t"); // GH env preserved
    // bsc-agent is a one-shot loop, not a REPL → always bake the intro + request resume.
    expect(l.startupPromptFreshOnly).toBe(false);
    expect(l.continueSession).toBe(true);
  });

  it("carries the plan-only role gate to the bsc-agent runtime via BSC_AGENT_PERMS", () => {
    const l = plannerLaunchConfig(store({ llmProvider: "ollama" }), GH);
    const perms = JSON.parse(l.env.BSC_AGENT_PERMS);
    // Planner is plan-only: writes are SCOPED to the plan-file globs (not arbitrary code), and the
    // mutating git/gh commands are denied — the runtime's analogue of the claude role gate.
    expect(Array.isArray(perms.write_globs)).toBe(true);
    expect(perms.write_globs.length).toBeGreaterThan(0);
    expect(Array.isArray(perms.deny_bash)).toBe(true);
    expect(perms.deny_bash.length).toBeGreaterThan(0);
  });

  it("also runs on bsc-agent when the user explicitly chose it for a cloud provider", () => {
    const l = plannerLaunchConfig(store({ llmProvider: "openai", llmModel: "gpt-5", openaiKey: "k", fleetHarness: "bsc-agent" }), GH);
    expect(l.providerId).toBe("bsc-agent");
    expect(l.env.BSC_AGENT_PROVIDER).toBe("openai");
    expect(l.env.BSC_AGENT_API_KEY).toBe("k");
  });
});
