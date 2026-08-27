// The director's model choice reaches the worker — `the-director-chooses-each-workers-model`.
//
// THE CHAIN ALREADY EXISTED. `bsc teams model` and `bsc persona model` both document it, nearest
// first: a fleet stream's own model > a team placement's > the persona's default > the harness's own
// default. `streamPaneWiring` already routes a stream's model into `paneModels`.
//
// IT DIED AT THE LAST STEP, for a local worker only. `BscAgentAdapter.model_flag` returns None (the
// model is env-selected, not a CLI flag) and `buildAgentEnv` filled `BSC_AGENT_MODEL` from the
// GLOBAL `llmModel` via `resolveLlmConfig`. So a director could set a stream's model, watch it land
// in `paneModels`, and every local worker would still run the one model configured in Settings.
//
// CLAUDE CLI REMAINS THE DEFAULT. Nothing here changes a Claude pane, and an unset model still means
// the harness decides — the assertions below pin both of those as much as they pin the fix.
import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "@/store";
import { buildAgentEnv, paneLlmConfig } from "@/app/console/lib/sessionLaunch";
import { DEFAULT_LOCAL_MODEL } from "@/shared/lib/core/llmConfig";

const envFor = (paneId: string, providerId = "bsc-agent") =>
  buildAgentEnv(useAppStore.getState(), paneId, providerId, "") ?? {};

describe("a local worker runs the model the director chose", () => {
  beforeEach(() => {
    useAppStore.setState({
      llmProvider: "ollama",
      llmModel: "qwen3-coder",   // the GLOBAL setting — what every local worker used to run
      paneModels: {},
      localBaseUrl: "http://localhost:11434/v1",
    } as never);
  });

  it("uses the pane's model over the globally configured one", () => {
    // The fix, in one assertion. Before it, this returned the global "qwen3-coder" no matter what
    // the director had assigned to the stream.
    useAppStore.setState({ paneModels: { "proj:auth": "qwen3.5:9b" } } as never);
    expect(envFor("proj:auth").BSC_AGENT_MODEL).toBe("qwen3.5:9b");
  });

  it("leaves a pane with no model of its own on the configured one", () => {
    // Unset means "nothing nearer in the chain applies" — not "no model".
    expect(envFor("proj:auth").BSC_AGENT_MODEL).toBe("qwen3-coder");
  });

  it("lets two workers in the same fleet run DIFFERENT models", () => {
    // The point of putting the choice at the STREAM level rather than globally: a director can put
    // the expensive model on the hard stream and a cheap one everywhere else.
    useAppStore.setState({
      paneModels: { "proj:auth": "qwen3.5:35b-a3b", "proj:ui": "qwen3.5:9b" },
    } as never);
    expect(envFor("proj:auth").BSC_AGENT_MODEL).toBe("qwen3.5:35b-a3b");
    expect(envFor("proj:ui").BSC_AGENT_MODEL).toBe("qwen3.5:9b");
  });
});

describe("a Claude tier is not a local model", () => {
  beforeEach(() => {
    useAppStore.setState({
      llmProvider: "ollama",
      llmModel: "qwen3-coder",
      paneModels: {},
      localBaseUrl: "http://localhost:11434/v1",
    } as never);
  });

  it("does NOT send a tier id to a local endpoint", () => {
    // The trap this guards. `haiku-4.5`/`sonnet-4.5`/`opus-4.5` are Claude Code CLI aliases; Ollama
    // 404s on them. `resolveModel` already guards the neighbouring case — a stale `claude-*` id on a
    // local provider — but a TIER id does not start with "claude", so it sails straight through.
    //
    // A pane still carrying a tier while the provider is local means nobody chose a local model for
    // it, so the configured one is the right answer.
    for (const tier of ["haiku-4.5", "sonnet-4.5", "opus-4.5"]) {
      useAppStore.setState({ paneModels: { "proj:auth": tier } } as never);
      expect(envFor("proj:auth").BSC_AGENT_MODEL, `${tier} must not reach Ollama`).toBe("qwen3-coder");
    }
  });

  it("still substitutes the local default when the global model is a stale claude-* id", () => {
    // The pre-existing #404 guard must survive the new one — both paths lead to a runnable model.
    useAppStore.setState({ llmModel: "claude-sonnet-4-6", paneModels: {} } as never);
    expect(envFor("proj:auth").BSC_AGENT_MODEL).toBe(DEFAULT_LOCAL_MODEL);
  });
});

describe("Claude CLI stays the default", () => {
  it("does not touch a Claude pane's env — its model is a CLI flag, not an env var", () => {
    // `buildAgentEnv` only assembles BSC_AGENT_* for a bsc-agent pane. A Claude pane's model still
    // reaches the harness as `claude --model <tier>`, exactly as before.
    useAppStore.setState({
      llmProvider: "anthropic",
      paneModels: { "proj:auth": "opus-4.5" },
    } as never);
    expect(envFor("proj:auth", "claude").BSC_AGENT_MODEL).toBeUndefined();
  });

  it("leaves a hosted provider's config alone even when the pane names a model", () => {
    // The override is scoped to providers that need bsc-agent. A hosted provider manages its own
    // model selection, and a pane tier must not start rewriting an OpenAI/Gemini model id.
    useAppStore.setState({
      llmProvider: "openai",
      llmModel: "gpt-5",
      openaiKey: "k",
      paneModels: { "proj:auth": "opus-4.5" },
    } as never);
    expect(paneLlmConfig(useAppStore.getState(), "proj:auth").model).toBe("gpt-5");
  });
});
