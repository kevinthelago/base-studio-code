// The algorithm-kind classifier (#3210) — infers the manipulation kind from name/id/tags (+ code hint).
import { describe, it, expect } from "vitest";
import { classifyKind } from "./classifyKind";
import { resolveKind } from "../viz/examples/registry";

const im = (name: string, extra: { id?: string; code?: string; tags?: string[] } = {}) => ({
  name,
  id: extra.id ?? `${name}.rs`,
  code: extra.code,
  tags: extra.tags,
});

describe("classifyKind (#3210)", () => {
  it("classifies the whole sort family as sort (name-driven)", () => {
    for (const n of ["merge_sort", "quick_sort", "bubble_sort", "insertion_sort", "heap_sort", "topological_sort"]) {
      expect(classifyKind(im(n, { id: `${n.replace("_", "-")}.rs` }))).toBe("sort");
    }
  });

  it("classifies searches, traversals, and accumulations", () => {
    expect(classifyKind(im("binary_search", { id: "binary-search.rs" }))).toBe("search");
    expect(classifyKind(im("find", { id: "find.rs" }))).toBe("search");
    expect(classifyKind(im("bfs"))).toBe("traversal");
    expect(classifyKind(im("dfs"))).toBe("traversal");
    expect(classifyKind(im("graph_traverse"))).toBe("traversal");
    expect(classifyKind(im("fibonacci", { id: "fibonacci.ts" }))).toBe("accumulate");
    expect(classifyKind(im("factorial"))).toBe("accumulate");
  });

  it("disambiguates: a *-first-search is a traversal, a topological-sort is a sort", () => {
    expect(classifyKind(im("breadth_first_search", { id: "breadth-first-search.rs" }))).toBe("traversal");
    expect(classifyKind(im("topological_sort", { id: "topological-sort.rs" }))).toBe("sort");
  });

  it("falls back to code patterns for un-obvious names, else null", () => {
    // lo/hi/mid bisection → search; an element swap → sort.
    expect(classifyKind(im("solve", { code: "let mid = (lo + hi) >> 1;" }))).toBe("search");
    expect(classifyKind(im("order", { code: "swap(a, i, j);" }))).toBe("sort");
    // Genuinely unclassifiable → null (never a false type).
    expect(classifyKind(im("frobnicate", { code: "return x + 1;" }))).toBeNull();
  });
});

describe("resolveKind (#3210)", () => {
  it("prefers the creator-assigned kind over the heuristic", () => {
    // Name says sort, but the assigned kind wins.
    expect(resolveKind({ name: "quick_sort", id: "quick-sort.rs", kind: "search" })).toBe("search");
  });

  it("falls back to the classifier when no kind is assigned", () => {
    expect(resolveKind({ name: "merge_sort", id: "merge-sort.rs" })).toBe("sort");
    expect(resolveKind({ name: "frobnicate", id: "frobnicate.rs" })).toBeNull();
  });
});
