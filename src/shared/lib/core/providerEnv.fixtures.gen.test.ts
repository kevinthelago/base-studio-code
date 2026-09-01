// The provider environment, captured from the LIVE TypeScript so the Rust mapping can be proved equal.
//
// Everything downstream of these two functions is Rust: `crates/bsc-agent/src/main.rs` reads
// `BSC_AGENT_PROVIDER`/`MODEL`/`API_KEY`, and `crates/llm` reads `BSC_AGENT_NUM_CTX` and clamps
// `num_ctx` by it (#1829). So the entire model-reaching configuration is consumed in Rust and was
// composed here.
//
// THE CASE THIS FIXTURE EXISTS FOR is `numCtx: 0`. The TypeScript tests `!== undefined`, deliberately
// NOT truthiness, because 0 MEANS "do not set num_ctx" — an instruction, not an absence. A truthy test
// drops exactly that instruction while looking correct. `build_provider` has honoured the variable
// since #1829 but nothing ever SET it, so the one escape hatch for a prompt that overflows its window
// existed and was unreachable.
//
//     UPDATE_FIXTURES=1 npx vitest run src/shared/lib/core/providerEnv.fixtures.gen.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { bscAgentEnv, aiderEnv, aiderModelArg } from "@/shared/lib/core/llmConfig";
import type { LlmConfig, LlmProvider } from "@/shared/lib/core/llmConfig";

const FIXTURE = join(process.cwd(), "src/shared/lib/core/providerEnv.fixtures.json");

const PROVIDERS: LlmProvider[] = ["anthropic", "openai", "gemini", "local", "ollama"];

const cfg = (over: Partial<LlmConfig> = {}): LlmConfig => ({
  provider: "anthropic", model: "opus-4.5", apiKey: "", baseUrl: "", numCtx: undefined, ...over,
});

type Case = { label: string; cfg: LlmConfig };

const SUBJECTS: Case[] = [
  ...PROVIDERS.map((p) => ({ label: `provider ${p}, keyed`, cfg: cfg({ provider: p, apiKey: "sk-secret" }) })),
  ...PROVIDERS.map((p) => ({ label: `provider ${p}, NO key`, cfg: cfg({ provider: p }) })),

  { label: "a local endpoint with a base URL", cfg: cfg({ provider: "ollama", model: "qwen2.5-coder", baseUrl: "http://box:11434/v1" }) },
  { label: "a local endpoint with NO base URL", cfg: cfg({ provider: "ollama", model: "qwen2.5-coder" }) },
  { label: "a local endpoint WITH a key too", cfg: cfg({ provider: "local", model: "llama3", baseUrl: "http://box:11434/v1", apiKey: "sk-x" }) },

  // THE numCtx SHAPES. `0` is an instruction; a truthy test would drop it.
  { label: "numCtx ABSENT — say nothing, let the runtime use its packaged ceiling", cfg: cfg({ numCtx: undefined }) },
  { label: "numCtx 0 — a real instruction meaning DO NOT set num_ctx", cfg: cfg({ numCtx: 0 }) },
  { label: "numCtx 1 — the smallest truthy value", cfg: cfg({ numCtx: 1 }) },
  { label: "numCtx 65536", cfg: cfg({ numCtx: 65536 }) },
  { label: "numCtx 0 on a local provider", cfg: cfg({ provider: "ollama", model: "q", baseUrl: "http://b:1/v1", numCtx: 0 }) },

  // Model-selector shapes.
  { label: "an already-namespaced model passes through", cfg: cfg({ provider: "anthropic", model: "vendor/some-model" }) },
  { label: "a model with surrounding whitespace", cfg: cfg({ provider: "openai", model: "  gpt-4o  " }) },
];

describe("providerEnv fixtures", () => {
  it("captures the bsc-agent env, the aider env and the model selector", () => {
    const cases = SUBJECTS.map((c) => ({
      label: c.label,
      config: c.cfg,
      bscAgent: bscAgentEnv(c.cfg),
      aider: aiderEnv(c.cfg),
      aiderModel: aiderModelArg(c.cfg),
    }));
    const next = { note: "GENERATED from @/shared/lib/core/llmConfig — do not hand-edit; see the .gen.test.ts", cases };

    if (process.env.UPDATE_FIXTURES) writeFileSync(FIXTURE, `${JSON.stringify(next, null, 2)}\n`);
    expect(existsSync(FIXTURE), `${FIXTURE} missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(next);
  });

  it("numCtx 0 IS emitted and absent is NOT — the difference a truthy test destroys", () => {
    expect(bscAgentEnv(cfg({ numCtx: 0 })).BSC_AGENT_NUM_CTX, "0 means DO NOT set num_ctx").toBe("0");
    expect(bscAgentEnv(cfg({ numCtx: undefined })).BSC_AGENT_NUM_CTX, "absent says nothing").toBeUndefined();
    expect(bscAgentEnv(cfg({ numCtx: 65536 })).BSC_AGENT_NUM_CTX).toBe("65536");
  });

  it("an empty key or base URL emits NO variable rather than an empty one", () => {
    const e = bscAgentEnv(cfg({ apiKey: "", baseUrl: "" }));
    expect(e.BSC_AGENT_API_KEY).toBeUndefined();
    expect(e.BSC_AGENT_BASE_URL).toBeUndefined();
  });

  it("the local Aider path always supplies a NON-EMPTY key — the client will not init without one", () => {
    for (const p of ["local", "ollama"] as LlmProvider[]) {
      const e = aiderEnv(cfg({ provider: p, baseUrl: "http://b:1/v1" }));
      expect(e.OPENAI_API_KEY, `${p}: a keyless local server still needs a non-empty key`).toBeTruthy();
    }
  });
});
