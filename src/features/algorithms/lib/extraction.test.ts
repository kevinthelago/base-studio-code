// The extracted-from-code implementation model (#2777): grouping matched sites by concept, counting
// them, and deriving the >1-site (duplicate) set. Pure — no bridge, hand-built ExtractResult.
import { describe, it, expect } from "vitest";
import { sitesByConcept, siteCounts, duplicateConcepts, callsFor, type ExtractResult } from "./extraction";

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
  calls: [
    { from: "merge-sort", to: "merge", tech: "typescript" },
    { from: "merge-sort", to: "merge", tech: "rust" },
    { from: "quick-sort", to: "merge", tech: "typescript" },
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

  it("callsFor returns a concept's OUTBOUND call edges only (#2779)", () => {
    const ms = callsFor(RESULT, "merge-sort");
    expect(ms).toHaveLength(2); // both tech edges out of merge-sort
    expect(ms.every((c) => c.from === "merge-sort" && c.to === "merge")).toBe(true);
    expect(ms.map((c) => c.tech)).toEqual(["typescript", "rust"]); // order preserved
    // A concept with a single outbound edge, and one with none.
    expect(callsFor(RESULT, "quick-sort")).toEqual([{ from: "quick-sort", to: "merge", tech: "typescript" }]);
    expect(callsFor(RESULT, "merge")).toEqual([]); // merge is only a callee here, never a caller
  });

  it("degrades to empty maps for an all-empty result", () => {
    const empty: ExtractResult = { matched: [], unmatched: [], duplicates: [], calls: [] };
    expect(sitesByConcept(empty).size).toBe(0);
    expect(siteCounts(empty).size).toBe(0);
    expect(duplicateConcepts(empty).size).toBe(0);
    expect(callsFor(empty, "merge-sort")).toEqual([]);
  });
});
