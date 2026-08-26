// The per-agent context cap, end to end: the Settings field → `$BSC_AGENT_NUM_CTX`.
//
// WHY THIS FILE EXISTS SEPARATELY. `llmConfig` is a record, and a record carries its own tests — but a
// carried test can only be written by `bsc graph tests harvest`, which pairs by COLOCATED FILE, and
// this module's file was retired long ago. So its carried test is frozen at whatever it was when the
// file last existed and cannot be extended in place (filed as `bsc request` 139's sibling, 138). The
// new assertions live here instead. If that gap is ever closed, fold these back onto the record.
//
// WHAT IS BEING PINNED. `build_provider` in `crates/llm` has honoured `$BSC_AGENT_NUM_CTX` since
// #1829, but NOTHING EVER SET IT — Settings → LLM provider → "Per-agent context cap" was an
// uncontrolled `<input defaultValue="64000">` bound to no store field. So the only escape hatch for a
// prompt that overflows its context window existed and was unreachable, and the cost of overflowing is
// not proportional: Ollama truncates an at-or-over-window prompt to HALF the window and keeps the
// tail, discarding the head — which is where `CLAUDE.md` sits.
//
// MEASURED on this repo before the fix: a 33,580-token prompt against `num_ctx` 32,768 came back as
//   `truncating input prompt limit=16386 prompt=33580 keep=4 new=16386`
// in the Ollama server log, while the client cheerfully reported "context=121084 chars". The client
// cannot see the loss, which is why it went unnoticed — so these tests guard the wiring, not a symptom.
import { describe, it, expect } from "vitest";
import {
  resolveLlmConfig, bscAgentEnv, parseNumCtx, DEFAULT_NUM_CTX,
  type LlmConfigSource,
} from "@/shared/lib/core/llmConfig";

const base: LlmConfigSource = {
  llmProvider: "ollama",
  llmModel: "qwen3.5:9b",
  claudeApiKey: "",
  openaiKey: "",
  geminiKey: "",
  localBaseUrl: "http://localhost:11434/v1",
  llmNumCtx: "",
};

describe("parseNumCtx — three states, and they do not collapse into two", () => {
  it("reads an empty field as UNSET, not as zero", () => {
    // Unset must stay unset: it means "use the runtime's packaged ceiling", so raising that ceiling
    // reaches every install rather than only the ones that never opened the field. Collapsing it to
    // 0 would instead tell the runtime to set no `num_ctx` at all — the opposite instruction.
    expect(parseNumCtx("")).toBeUndefined();
    expect(parseNumCtx("   ")).toBeUndefined();
  });

  it("keeps `0` as a real value — it MEANS 'do not set num_ctx'", () => {
    expect(parseNumCtx("0")).toBe(0);
  });

  it("reads a typed ceiling, tolerating surrounding whitespace", () => {
    expect(parseNumCtx("65536")).toBe(65536);
    expect(parseNumCtx("  32768 ")).toBe(32768);
  });

  it("treats garbage and negatives as unset rather than passing nonsense downstream", () => {
    expect(parseNumCtx("lots")).toBeUndefined();
    expect(parseNumCtx("-1")).toBeUndefined();
  });
});

describe("the cap reaches the runtime as $BSC_AGENT_NUM_CTX", () => {
  it("carries a typed cap all the way from the store field to the env var", () => {
    // The whole point of the slice: what the user types in Settings is what the runtime is told.
    const cfg = resolveLlmConfig({ ...base, llmNumCtx: "65536" });
    expect(cfg.numCtx).toBe(65536);
    expect(bscAgentEnv(cfg).BSC_AGENT_NUM_CTX).toBe("65536");
  });

  it("passes `0` through instead of dropping it", () => {
    // The subtle half. A truthy `if (cfg.numCtx)` would silently discard exactly this instruction
    // while looking correct — 0 and unset are DIFFERENT requests to the runtime.
    const cfg = resolveLlmConfig({ ...base, llmNumCtx: "0" });
    expect(bscAgentEnv(cfg).BSC_AGENT_NUM_CTX).toBe("0");
  });

  it("says NOTHING when the field is blank, so the runtime's own default applies", () => {
    const cfg = resolveLlmConfig({ ...base, llmNumCtx: "" });
    expect("BSC_AGENT_NUM_CTX" in bscAgentEnv(cfg)).toBe(false);
  });

  it("is absent for a source that predates the field entirely", () => {
    // `llmNumCtx` is OPTIONAL on LlmConfigSource on purpose: the interface is a structural subset so
    // the resolver stays unit-testable with a plain object, and adding a field must not invalidate
    // every existing caller's literal. Absent behaves exactly as blank.
    const { llmNumCtx: _omitted, ...withoutTheField } = base;
    expect("BSC_AGENT_NUM_CTX" in bscAgentEnv(resolveLlmConfig(withoutTheField))).toBe(false);
  });
});

describe("the packaged default", () => {
  it("is a real number the Settings placeholder can show", () => {
    // The old placeholder was the string "64000", which matched no default on either side of the
    // language boundary. This one comes from `@data/console/model-defaults.json`.
    expect(Number.isInteger(DEFAULT_NUM_CTX)).toBe(true);
    expect(DEFAULT_NUM_CTX).toBeGreaterThan(0);
  });

  it("is big enough for this app's OWN composed system prompt", () => {
    // Not an arbitrary number. The context this app composes for a worker — the CLAUDE.md chain +
    // CLAUDE.local.md + skills + the CLI inventory + the agent preamble + serialized tool schemas —
    // measured 33,580 tokens on the base-studio-code checkout. A default at or below that guarantees
    // the truncation this slice exists to remove, so the floor is a real constraint, not taste.
    expect(DEFAULT_NUM_CTX).toBeGreaterThan(33_580);
  });

  // The Rust side compiles its own copy of this number as `DEFAULT_NUM_CTX_CAP`, because the cap has
  // to apply when nothing sets the env var at all. `default_num_ctx_cap_matches_the_packaged_default`
  // in `crates/llm/src/ollama.rs` reads the same JSON and fails if the two diverge — that guard lives
  // there rather than here because only the Rust side can see its own constant.
});
