// Edge batching (#4150) — the merge must change the ELEMENT COUNT and nothing else.
import { describe, it, expect } from "vitest";
import { batchEdges, type EdgeGeom } from "./edgeBatch";

const g = (d: string, arrow: string): EdgeGeom => ({ d, arrow });
const E = ["a", "b", "c"];
const geomOf = (e: string) => g(`M0 0 L1 ${e.charCodeAt(0)}`, `M2 2 L3 3 Z`);

describe("batchEdges", () => {
  it("concatenates the bulk into exactly the subpaths the separate elements drew", () => {
    const out = batchEdges(E, geomOf);
    // Space-joined so each subpath keeps its own leading `M` — the merged path is the same pen strokes.
    expect(out.d).toBe([geomOf("a").d, geomOf("b").d, geomOf("c").d].join(" "));
    expect(out.arrow).toBe([geomOf("a").arrow, geomOf("b").arrow, geomOf("c").arrow].join(" "));
    expect(out.individual).toEqual([]);
  });

  it("holds back the edges marked individual, and keeps them OUT of the bulk", () => {
    const out = batchEdges(E, geomOf, (e) => e === "b");
    expect(out.individual).toEqual(["b"]);
    expect(out.d).toBe([geomOf("a").d, geomOf("c").d].join(" "));
    expect(out.d).not.toContain(geomOf("b").d);
  });

  it("drops an edge whose geometry is null — an endpoint with no laid-out position", () => {
    const out = batchEdges(E, (e) => (e === "b" ? null : geomOf(e)));
    expect(out.d).toBe([geomOf("a").d, geomOf("c").d].join(" "));
    // A dropped edge is not silently promoted to individual either.
    expect(out.individual).toEqual([]);
  });

  it("drops a null edge even when it is marked individual", () => {
    // Order matters: geometry is resolved FIRST, so an unpositioned highlighted edge cannot reach the
    // caller and be rendered at undefined coordinates.
    const out = batchEdges(E, (e) => (e === "b" ? null : geomOf(e)), (e) => e === "b");
    expect(out.individual).toEqual([]);
  });

  it("yields empty strings for no edges, so the caller renders no stray path", () => {
    const out = batchEdges([], geomOf);
    expect(out).toEqual({ d: "", arrow: "", individual: [] });
    // …and when every edge is held back, the bulk is empty rather than a lone separator.
    expect(batchEdges(E, geomOf, () => true).d).toBe("");
  });

  it("preserves input order in both the bulk and the individual list", () => {
    const out = batchEdges(E, geomOf, (e) => e !== "b");
    expect(out.individual).toEqual(["a", "c"]);
    expect(out.d).toBe(geomOf("b").d);
  });

  it("omits an empty geometry string instead of emitting a separator for it", () => {
    const out = batchEdges(["x", "y"], (e) => (e === "x" ? g("", "") : g("M9 9", "M8 8 Z")));
    expect(out.d).toBe("M9 9");
    expect(out.arrow).toBe("M8 8 Z");
  });
});
