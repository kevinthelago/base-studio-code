import { describe, it, expect } from "vitest";
import { reconcileDesign, KNOWN_GRAPH_CATEGORIES } from "./reconcile";

describe("reconcileDesign (#2646)", () => {
  it("KNOWN_GRAPH_CATEGORIES = the contract's graph-category keys", () => {
    expect(KNOWN_GRAPH_CATEGORIES.has("greenfield")).toBe(true);
    expect(KNOWN_GRAPH_CATEGORIES.has("script")).toBe(true); // #2596
    expect(KNOWN_GRAPH_CATEGORIES.has("simulation")).toBe(false);
  });

  it("no contribution → complete, nothing missing", () => {
    expect(reconcileDesign(undefined)).toEqual({ missingCategories: [], themeRef: undefined, complete: true });
    expect(reconcileDesign({})).toEqual({ missingCategories: [], themeRef: undefined, complete: true });
  });

  it("known categories are NOT missing; unknown ones ARE (deduped + sorted)", () => {
    expect(reconcileDesign({ categories: ["greenfield", "transform"] }).missingCategories).toEqual([]);
    const r = reconcileDesign({ categories: ["simulation", "greenfield", "analysis", "simulation"] });
    expect(r.missingCategories).toEqual(["analysis", "simulation"]); // unknown only, deduped, sorted
    expect(r.complete).toBe(false);
  });

  it("carries the theme ref through", () => {
    expect(reconcileDesign({ theme: "soft" }).themeRef).toBe("soft");
    expect(reconcileDesign({ categories: ["greenfield"], theme: "warm" })).toEqual({
      missingCategories: [],
      themeRef: "warm",
      complete: true,
    });
  });

  it("accepts a custom known set (feature-agnostic)", () => {
    expect(reconcileDesign({ categories: ["x"] }, new Set(["x"])).missingCategories).toEqual([]);
    expect(reconcileDesign({ categories: ["x"] }, new Set(["y"])).missingCategories).toEqual(["x"]);
  });
});
