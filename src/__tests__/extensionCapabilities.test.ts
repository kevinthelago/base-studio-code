import { describe, it, expect } from "vitest";
import {
  ALL_CAPABILITIES, CAPABILITY_INFO, isCapability, partitionCapabilities, maxRisk,
} from "../lib/extensions/capabilities";
import {
  validatePipelineExtension, isCodeRuntime, CODE_RUNTIMES,
} from "../lib/extensions/pipelineExtension";
import { wrapExtension, type ExtensionManifest } from "../lib/extensions/manifest";

describe("capabilities (#598 M3)", () => {
  it("every capability has info", () => {
    for (const c of ALL_CAPABILITIES) expect(CAPABILITY_INFO[c]).toBeTruthy();
  });
  it("isCapability gates the vocabulary", () => {
    expect(isCapability("render")).toBe(true);
    expect(isCapability("filesystem")).toBe(false);
  });
  it("partitions known vs unknown (deduped)", () => {
    expect(partitionCapabilities(["render", "render", "bogus", "network"])).toEqual({
      known: ["render", "network"], unknown: ["bogus"],
    });
  });
  it("maxRisk reflects the riskiest capability", () => {
    expect(maxRisk([])).toBe("none");
    expect(maxRisk(["read-signals", "render"])).toBe("low");
    expect(maxRisk(["read-signals", "write-files"])).toBe("high");
  });
});

describe("pipeline-extension validation (#598 M3)", () => {
  const codePayload = (over = {}) => ({ runtime: "iframe", suits: ["ui"], trigger: "manual", entry: "pipeline.js", ...over });

  it("accepts a valid code pipeline (entry + integrity + known caps)", () => {
    const m = wrapExtension("pipeline", "vue-widgets", "Vue widgets", "1.0.0", codePayload(), {
      capabilities: ["render"], integrity: "sha256:abc",
    });
    const v = validatePipelineExtension(m);
    expect(v.ok).toBe(true);
    expect(v.isCode).toBe(true);
  });

  it("a code pipeline must declare an entry bundle and pin integrity", () => {
    const noEntry = wrapExtension("pipeline", "p", "P", "1", { runtime: "iframe", suits: ["ui"], trigger: "manual" }, { capabilities: ["render"], integrity: "sha256:x" });
    expect(validatePipelineExtension(noEntry).errors.some((e) => /entry/.test(e))).toBe(true);
    const noIntegrity = wrapExtension("pipeline", "p", "P", "1", codePayload());
    expect(validatePipelineExtension(noIntegrity).errors.some((e) => /integrity/.test(e))).toBe(true);
  });

  it("rejects an unknown runtime and unknown capabilities", () => {
    // Built directly (bypassing the typed wrapExtension) to feed deliberately bad values.
    const m = {
      manifest: 1, kind: "pipeline", id: "p", name: "P", version: "1",
      capabilities: ["telepathy"], payload: { runtime: "magic", suits: ["ui"], trigger: "manual" },
    } as unknown as ExtensionManifest;
    const v = validatePipelineExtension(m);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => /runtime/.test(e))).toBe(true);
    expect(v.errors.some((e) => /capabilit/i.test(e))).toBe(true);
  });

  it("a declarative pipeline needs no entry/integrity (not code)", () => {
    const m = wrapExtension("pipeline", "lint", "Lint", "1", { runtime: "declarative", suits: ["*"], trigger: "on completion", spec: {} });
    const v = validatePipelineExtension(m);
    expect(v.ok).toBe(true);
    expect(v.isCode).toBe(false);
  });

  it("rejects a non-pipeline manifest", () => {
    expect(validatePipelineExtension(wrapExtension("blueprint", "b", "B", "1", {})).ok).toBe(false);
  });

  it("CODE_RUNTIMES classification", () => {
    expect(isCodeRuntime("iframe")).toBe(true);
    expect(isCodeRuntime("worker")).toBe(true);
    expect(isCodeRuntime("declarative")).toBe(false);
    expect(CODE_RUNTIMES).toContain("iframe");
  });
});
