// The intent-vs-reality composition diff (#2781): declared `composes` edges (intent) vs extracted
// `calls` (reality), per IMPLEMENTED concept. Pure — a hand-built KnowledgeGraph + ExtractResult.
import { describe, it, expect } from "vitest";
import { composeDiff, driftConcepts } from "./compositionDiff";
import type { KnowledgeGraph } from "./knowledge";
import type { ExtractResult } from "./extraction";

const graph: KnowledgeGraph = {
  nodes: [
    { id: "merge-sort", kind: "algorithm", name: "Merge Sort", summary: "", provenance: "seed" },
    { id: "quick-sort", kind: "algorithm", name: "Quick Sort", summary: "", provenance: "seed" },
    { id: "fibonacci", kind: "algorithm", name: "Fibonacci", summary: "", provenance: "seed" },
    { id: "merge", kind: "algorithm", name: "Merge", summary: "", provenance: "seed" },
    { id: "divide-and-conquer", kind: "concept", name: "Divide & Conquer", summary: "", provenance: "seed" },
    { id: "recursion", kind: "concept", name: "Recursion", summary: "", provenance: "seed" },
    { id: "dynamic-programming", kind: "concept", name: "Dynamic Programming", summary: "", provenance: "seed" },
  ],
  edges: [
    { from: "merge-sort", rel: "composes", to: "merge" },
    { from: "merge-sort", rel: "composes", to: "divide-and-conquer" },
    { from: "merge-sort", rel: "operates-on", to: "merge" }, // non-composes → MUST be ignored
    { from: "quick-sort", rel: "composes", to: "divide-and-conquer" },
    { from: "fibonacci", rel: "composes", to: "recursion" },
    { from: "fibonacci", rel: "composes", to: "dynamic-programming" },
  ],
  implementations: [],
};

// merge-sort: real code calls merge (matched) + recursion (extra), but NOT divide-and-conquer (missing).
// quick-sort: real code makes NO calls → its declared divide-and-conquer is missing.
// merge:      implemented, declares nothing, calls nothing → an all-empty (matching) entry.
// fibonacci:  real code calls exactly its declared pair (in reverse order) → matches; tests sorting.
const extract: ExtractResult = {
  matched: [
    { concept: "merge-sort", tech: "typescript", file: "a.ts", line: 1 },
    { concept: "quick-sort", tech: "typescript", file: "b.ts", line: 1 },
    { concept: "merge", tech: "typescript", file: "c.ts", line: 1 },
    { concept: "fibonacci", tech: "typescript", file: "d.ts", line: 1 },
  ],
  unmatched: [{ tech: "typescript", file: "e.ts", line: 1 }],
  duplicates: [],
  calls: [
    { from: "merge-sort", to: "merge", tech: "typescript" },
    { from: "merge-sort", to: "merge", tech: "rust" }, // duplicate per-tech edge → collapses to one
    { from: "merge-sort", to: "recursion", tech: "typescript" },
    { from: "fibonacci", to: "dynamic-programming", tech: "typescript" },
    { from: "fibonacci", to: "recursion", tech: "typescript" },
  ],
};

describe("composeDiff (#2781)", () => {
  const diffs = composeDiff(graph, extract);

  it("diffs an implemented concept into matched / missing / extra", () => {
    const d = diffs.get("merge-sort")!;
    expect(d.matched).toEqual(["merge"]);              // declared ∩ actual
    expect(d.missing).toEqual(["divide-and-conquer"]); // declared − actual
    expect(d.extra).toEqual(["recursion"]);            // actual − declared
  });

  it("only counts `composes` edges as declared (ignores operates-on/etc)", () => {
    // merge-sort's operates-on→merge edge does not add a second declared entry; merge stays matched
    // (not doubled) and no spurious entries appear.
    const d = diffs.get("merge-sort")!;
    expect(d.matched).toEqual(["merge"]);
    expect(d.missing.concat(d.extra)).not.toContain("merge");
  });

  it("collapses duplicate per-tech call edges", () => {
    // merge-sort calls merge in BOTH ts and rust — it appears once in matched, not twice.
    expect(diffs.get("merge-sort")!.matched).toEqual(["merge"]);
  });

  it("sorts + de-dupes each array", () => {
    // fibonacci declares {recursion, dynamic-programming} and the calls arrive reversed — matched is
    // returned alphabetically sorted.
    const d = diffs.get("fibonacci")!;
    expect(d.matched).toEqual(["dynamic-programming", "recursion"]);
    expect(d.missing).toEqual([]);
    expect(d.extra).toEqual([]);
  });

  it("keeps an all-empty entry for an implemented, fully-matching concept", () => {
    const d = diffs.get("merge")!;
    expect(d).toBeTruthy();
    expect(d.matched).toEqual([]);
    expect(d.missing).toEqual([]);
    expect(d.extra).toEqual([]);
  });

  it("omits concepts with NO extracted implementation", () => {
    // divide-and-conquer / recursion / dynamic-programming are nodes but never a matched `concept`.
    expect(diffs.has("divide-and-conquer")).toBe(false);
    expect(diffs.has("recursion")).toBe(false);
    expect(diffs.has("dynamic-programming")).toBe(false);
  });

  it("degrades to an empty map for an empty extract", () => {
    const empty: ExtractResult = { matched: [], unmatched: [], duplicates: [], calls: [] };
    expect(composeDiff(graph, empty).size).toBe(0);
  });
});

describe("driftConcepts (#2781)", () => {
  it("returns exactly the concepts with any missing OR extra", () => {
    const diffs = composeDiff(graph, extract);
    const drift = driftConcepts(diffs);
    expect(drift.has("merge-sort")).toBe(true); // missing + extra
    expect(drift.has("quick-sort")).toBe(true); // missing only
    expect(drift.has("fibonacci")).toBe(false); // fully matches
    expect(drift.has("merge")).toBe(false);     // all-empty diff
    expect(drift.size).toBe(2);
  });
});
