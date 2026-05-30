import { describe, it, expect } from "vitest";
import { languageStats } from "../screens/github/languageStats";

describe("languageStats", () => {
  it("sums bytes per language across repos", () => {
    const { totals } = languageStats({
      "a/x": { langBytes: { TypeScript: 100, Dockerfile: 20 } },
      "a/y": { langBytes: { TypeScript: 50, Rust: 30 } },
    });
    expect(totals).toEqual({ TypeScript: 150, Dockerfile: 20, Rust: 30 });
  });

  it("counts only repos that contributed language data", () => {
    const { repoCount } = languageStats({
      "a/x": { langBytes: { TypeScript: 100 } },
      "a/empty": { langBytes: {} }, // no detected language → not counted
      "a/y": { langBytes: { Rust: 10 } },
    });
    expect(repoCount).toBe(2);
  });

  it("does not conflate the language count with the repo count", () => {
    // One repo, four languages — repoCount must be 1, not 4 (the old bug).
    const { totals, repoCount } = languageStats({
      "a/x": { langBytes: { TypeScript: 4, Dockerfile: 1, Rust: 1, CSS: 1 } },
    });
    expect(Object.keys(totals)).toHaveLength(4);
    expect(repoCount).toBe(1);
  });

  it("handles an empty sample", () => {
    expect(languageStats({})).toEqual({ totals: {}, repoCount: 0 });
  });
});
