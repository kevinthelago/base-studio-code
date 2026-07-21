// The executable spec for the `llm-energy.ts` graph node — RETROFITTED (#3465).
//
// This node was harvested in #3462 and shipped with nothing referencing it anywhere in the repo: the
// graph promised runnable, self-contained code and no test ever ran it. That is precisely the failure
// mode #3465 exists to close, so the first thing the new mechanism does is cover the node that
// exposed it.
import { describe, it, expect } from "vitest";
import { estimateEnergyWh } from "./llmEnergy";

describe("estimateEnergyWh", () => {
  it("scales with tokens, output costing more than input", () => {
    // Output tokens are generated one forward pass each; input is processed in parallel. A model that
    // charged them equally would understate a chatty agent badly.
    const inOnly = estimateEnergyWh("claude-opus", 1000, 0);
    const outOnly = estimateEnergyWh("claude-opus", 0, 1000);
    expect(inOnly).toBeGreaterThan(0);
    expect(outOnly).toBeGreaterThan(inOnly);
    expect(estimateEnergyWh("claude-opus", 2000, 0)).toBeCloseTo(inOnly * 2);
  });

  it("tiers by model name — large > medium > small", () => {
    const large = estimateEnergyWh("claude-opus-4", 1000, 1000);
    const small = estimateEnergyWh("claude-haiku-4-5", 1000, 1000);
    const unknown = estimateEnergyWh("some-vendor-model-x", 1000, 1000);
    expect(large).toBeGreaterThan(unknown);
    expect(unknown).toBeGreaterThan(small);
  });

  it("an UNRECOGNISED hosted model is never free — it falls to the mid tier", () => {
    // The stated contract, and the one that matters: a model nobody has heard of costing 0 would make
    // the fleet's energy read low precisely when it is running something unusual.
    expect(estimateEnergyWh("totally-unknown-model", 1000, 1000)).toBeGreaterThan(0);
  });

  it("a LOCAL model costs no grid energy", () => {
    for (const model of ["ollama/llama3", "local-mistral", "qwen2.5", "deepseek-r1"]) {
      expect(estimateEnergyWh(model, 10_000, 10_000)).toBe(0);
    }
  });

  it("zero tokens is zero energy for every tier", () => {
    for (const model of ["claude-opus", "gpt-4", "haiku", "unknown"]) {
      expect(estimateEnergyWh(model, 0, 0)).toBe(0);
    }
  });
});
