// The extracted-from-code implementation model (#2777): grouping matched sites by concept, counting
// them, and deriving the >1-site (duplicate) set. Pure — no bridge, hand-built ExtractResult.
import { describe, it, expect } from "vitest";
import { sitesByConcept, siteCounts, duplicateConcepts, type ExtractResult } from "./extraction";

const RESULT: ExtractResult = {
  matched: [
    { concept: "merge-sort", tech: "typescript", name: "mergeSort", file: "src/sort/merge.ts", line: 3 },
    { concept: "merge-sort", tech: "rust", name: "merge_sort", file: "crates/sort/src/merge.rs", line: 12 },
    { concept: "binary-search", tech: "typescript", name: "bsearch", file: "src/search.ts", line: 7 },
  ],
  unmatched: [
    { tech: "typescript", name: "mystery", file: "src/misc.ts", line: 1 },
  ],
  duplicates: [
    {
      concept: "merge-sort",
      count: 2,
      sites: [
        { concept: "merge-sort", tech: "typescript", name: "mergeSort", file: "src/sort/merge.ts", line: 3 },
        { concept: "merge-sort", tech: "rust", name: "merge_sort", file: "crates/sort/src/merge.rs", line: 12 },
      ],
    },
  ],
};

describe("extraction model (#2777)", () => {
  it("sitesByConcept groups matched sites by concept, excluding unmatched", () => {
    const m = sitesByConcept(RESULT);
    expect(m.get("merge-sort")?.length).toBe(2);
    expect(m.get("binary-search")?.length).toBe(1);
    expect(m.has("mystery")).toBe(false); // unmatched sites never appear
    expect(m.get("merge-sort")?.map((s) => s.tech)).toEqual(["typescript", "rust"]); // order preserved
  });

  it("siteCounts counts matched sites per concept", () => {
    const c = siteCounts(RESULT);
    expect(c.get("merge-sort")).toBe(2); // 2-site concept
    expect(c.get("binary-search")).toBe(1); // 1-site concept
    expect(c.get("nope")).toBeUndefined();
  });

  it("duplicateConcepts is exactly the >1-site concepts", () => {
    const d = duplicateConcepts(RESULT);
    expect(d.has("merge-sort")).toBe(true); // 2 sites → duplicate
    expect(d.has("binary-search")).toBe(false); // 1 site → not a duplicate
    expect(d.size).toBe(1);
  });

  it("degrades to empty maps for an all-empty result", () => {
    const empty: ExtractResult = { matched: [], unmatched: [], duplicates: [] };
    expect(sitesByConcept(empty).size).toBe(0);
    expect(siteCounts(empty).size).toBe(0);
    expect(duplicateConcepts(empty).size).toBe(0);
  });
});
