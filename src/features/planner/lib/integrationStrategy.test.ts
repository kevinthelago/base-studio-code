import { describe, it, expect } from "vitest";
import {
  normalizeStrategy, resolveStrategy, strategySettings,
  STRATEGY_SETTINGS, DEFAULT_STRATEGY, INTEGRATION_STRATEGIES,
} from "@/features/planner/lib/integrationStrategy";

describe("normalizeStrategy (#378)", () => {
  it("accepts every valid strategy", () => {
    expect(normalizeStrategy("local")).toBe("local");
    expect(normalizeStrategy("self-merge")).toBe("self-merge");
    expect(normalizeStrategy("pr-ci")).toBe("pr-ci");
    expect(normalizeStrategy("manual")).toBe("manual");
  });
  it("trims surrounding whitespace", () => {
    expect(normalizeStrategy("  pr-ci  ")).toBe("pr-ci");
  });
  it("returns undefined for invalid / non-string input", () => {
    expect(normalizeStrategy("nope")).toBeUndefined();
    expect(normalizeStrategy("")).toBeUndefined();
    expect(normalizeStrategy(undefined)).toBeUndefined();
    expect(normalizeStrategy(42)).toBeUndefined();
    expect(normalizeStrategy(null)).toBeUndefined();
  });
});

describe("resolveStrategy (#378)", () => {
  it("prefers the per-stream override above all", () => {
    expect(resolveStrategy("manual", "pr-ci")).toBe("manual");
  });
  it("falls back to the fleet default when the stream is unset", () => {
    expect(resolveStrategy(undefined, "pr-ci")).toBe("pr-ci");
  });
  it("falls back to DEFAULT_STRATEGY when both are unset", () => {
    expect(resolveStrategy(undefined, undefined)).toBe(DEFAULT_STRATEGY);
    expect(DEFAULT_STRATEGY).toBe("local");
  });

  // The regression this item exists for: an unconfigured project must not integrate to a remote.
  // Both prior candidates did — `self-merge` pushed develop, `pr-ci` pushed a branch + opened a PR —
  // so a fleet launched with untouched settings wrote to GitHub regardless of intent.
  it("the default strategy never reaches a remote", () => {
    expect(strategySettings(resolveStrategy(undefined, undefined)).integrate).toBe("local");
  });
});

describe("STRATEGY_SETTINGS mapping (#378)", () => {
  it("maps each strategy onto its worker push + director mode", () => {
    expect(STRATEGY_SETTINGS["local"]).toEqual({ test: "full", integrate: "local", director: "integrator" });
    expect(STRATEGY_SETTINGS["self-merge"]).toEqual({ test: "full", integrate: "self-merge", director: "watchdog" });
    expect(STRATEGY_SETTINGS["pr-ci"]).toEqual({ test: "full", integrate: "auto-pr", director: "integrator" });
    expect(STRATEGY_SETTINGS["manual"]).toEqual({ test: "full", integrate: "commit-only", director: "integrator" });
  });
  it("strategySettings returns the same record entry", () => {
    for (const s of INTEGRATION_STRATEGIES) {
      expect(strategySettings(s)).toBe(STRATEGY_SETTINGS[s]);
    }
  });
});
