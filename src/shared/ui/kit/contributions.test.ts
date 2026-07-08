import { describe, it, expect } from "vitest";
import {
  compileContributionsCss,
  applyContributionsToRoot,
  contributionFromCategories,
  graphCategoryToken,
} from "./contributions";

describe("design contributions overlay (#2650)", () => {
  it("graphCategoryToken maps a category key to its --graph-category-<key> slot", () => {
    expect(graphCategoryToken("simulation")).toBe("--graph-category-simulation");
  });

  it("contributionFromCategories shapes generated colours into a token overlay", () => {
    expect(contributionFromCategories("bp-x", { simulation: "oklch(0.72 0.15 200)", analysis: "#abcdef" })).toEqual({
      source: "bp-x",
      tokens: { "--graph-category-simulation": "oklch(0.72 0.15 200)", "--graph-category-analysis": "#abcdef" },
    });
  });

  it("compileContributionsCss emits a :root block, last source wins, guards names + values", () => {
    const css = compileContributionsCss([
      { source: "a", tokens: { "--graph-category-simulation": "oklch(0.7 0.1 200)" } },
      { source: "b", tokens: { "--graph-category-simulation": "#111111", "--graph-category-analysis": "#222222" } },
    ]);
    expect(css.startsWith(":root {")).toBe(true);
    expect(css).toContain("--graph-category-simulation: #111111;"); // later source wins on a duplicate
    expect(css).toContain("--graph-category-analysis: #222222;");

    // guards: a bad token name + an injection value are skipped; the safe one survives.
    const guarded = compileContributionsCss([
      { source: "x", tokens: { "bad name": "red", "--ok": "blue", "--evil": "red; } body{}" } },
    ]);
    expect(guarded).toContain("--ok: blue;");
    expect(guarded).not.toContain("bad name");
    expect(guarded).not.toContain("--evil");

    expect(compileContributionsCss([])).toBe("");
    expect(compileContributionsCss([{ source: "e", tokens: {} }])).toBe("");
  });

  it("applyContributionsToRoot injects / updates / removes the managed <style>", () => {
    const doc = document.implementation.createHTMLDocument("t");
    applyContributionsToRoot([{ source: "a", tokens: { "--graph-category-x": "#fff" } }], doc);
    expect(doc.getElementById("bsc-ui-contributions")?.textContent).toContain("--graph-category-x: #fff;");

    applyContributionsToRoot([{ source: "a", tokens: { "--graph-category-x": "#000" } }], doc);
    expect(doc.getElementById("bsc-ui-contributions")?.textContent).toContain("#000");

    applyContributionsToRoot([], doc); // clearing removes the element → the contract's defaults resume
    expect(doc.getElementById("bsc-ui-contributions")).toBeNull();
  });
});
