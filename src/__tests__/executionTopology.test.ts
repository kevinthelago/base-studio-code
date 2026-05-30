import { describe, it, expect } from "vitest";
import {
  STRATEGY_PRESETS,
  validateStrategyCoherence,
  isCoherent,
  branchNameFor,
  slugify,
  type ExecutionStrategy,
} from "../screens/projects/executionTopology";

describe("presets", () => {
  it("every preset is coherent", () => {
    for (const preset of Object.values(STRATEGY_PRESETS)) {
      expect(validateStrategyCoherence(preset)).toEqual([]);
    }
  });
});

describe("validateStrategyCoherence", () => {
  const base = STRATEGY_PRESETS["stacked-dependency"];

  it("flags stacked branches without dependency-wave assignment", () => {
    const bad: ExecutionStrategy = { ...base, assignmentRule: "by-layer" };
    expect(validateStrategyCoherence(bad).map((i) => i.rule)).toContain("stacked-requires-wave");
  });

  it("flags per-stream branches without by-layer assignment", () => {
    const bad: ExecutionStrategy = { ...STRATEGY_PRESETS["fleet-stream"], assignmentRule: "single-agent" };
    const rules = validateStrategyCoherence(bad).map((i) => i.rule);
    expect(rules).toContain("per-stream-requires-by-layer");
    expect(rules).toContain("single-agent-not-multi");
  });

  it("flags single-agent driving a multi-agent branch layout", () => {
    const bad: ExecutionStrategy = { ...base, assignmentRule: "single-agent" };
    expect(validateStrategyCoherence(bad).map((i) => i.rule)).toContain("single-agent-not-multi");
  });

  it("isCoherent agrees", () => {
    expect(isCoherent(STRATEGY_PRESETS["solo-trunk"])).toBe(true);
    expect(isCoherent({ ...base, assignmentRule: "by-layer" })).toBe(false);
  });
});

describe("branchNameFor / slugify", () => {
  it("per-issue strategies use {issue}-{slug}", () => {
    expect(branchNameFor(STRATEGY_PRESETS["solo-trunk"], { issue: 204, desc: "Execution topology" })).toBe(
      "204-execution-topology",
    );
  });

  it("per-stream strategies use the stream id", () => {
    expect(branchNameFor(STRATEGY_PRESETS["fleet-stream"], { stream: "api-layer", issue: 7 })).toBe("api-layer");
  });

  it("stacked carries the issue id", () => {
    expect(branchNameFor(STRATEGY_PRESETS["stacked-dependency"], { issue: 5, desc: "foo bar" })).toBe("5-foo-bar");
  });

  it("slugify lowercases, hyphenates, trims, and caps to 6 words", () => {
    expect(slugify("Execution Topology!")).toBe("execution-topology");
    expect(slugify("a b c d e f g h")).toBe("a-b-c-d-e-f");
    expect(slugify("  --Weird__Name--  ")).toBe("weird-name");
  });
});
