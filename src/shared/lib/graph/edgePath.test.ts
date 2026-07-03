// graphEdge (#2222, graph design-language #2221) — the shared line-type; anchor + ports routing (#2226).
import { describe, it, expect } from "vitest";
import { graphEdge, type EdgeBox } from "./edgePath";

const A: EdgeBox = { x: 0, y: 0, w: 100, h: 40 };   // center (50,20), right border x=100
const B: EdgeBox = { x: 200, y: 0, w: 100, h: 40 };  // center (250,20), left border x=200

describe("graphEdge — anchor routing (#2222)", () => {
  it("leaves the source border facing the target and ends short of the target border", () => {
    const g = graphEdge(A, B);
    // Source anchor = right border of A (+3 outset) at the shared y.
    expect(g.d.startsWith("M 103 20 ")).toBe(true);
    // The curve ends 9px short of B's left border (200 + 3 outset = 197 → 188).
    expect(g.d.endsWith("188 20")).toBe(true);
  });

  it("puts the arrow tip on the target border, not at the curve end", () => {
    const g = graphEdge(A, B);
    expect(g.arrow.startsWith("M 197 20 ")).toBe(true); // tip at the border (197), curve stopped at 188
  });

  it("places the label near the midpoint of the run", () => {
    const g = graphEdge(A, B);
    expect(g.labelX).toBeGreaterThan(103);
    expect(g.labelX).toBeLessThan(197);
    expect(g.labelY).toBeCloseTo(20, 6); // straight horizontal edge, no bow
  });

  it("bows the curve off the straight line", () => {
    const straight = graphEdge(A, B);
    const bowed = graphEdge(A, B, { bow: 24 });
    expect(bowed.labelY).not.toBeCloseTo(straight.labelY, 1); // perpendicular offset moved the midpoint
  });

  it("omits the source arrow unless doubleEnded", () => {
    expect(graphEdge(A, B).arrowStart).toBeUndefined();
    const g = graphEdge(A, B, { doubleEnded: true });
    expect(g.arrowStart?.startsWith("M 103 20 ")).toBe(true); // a second arrow at the source border
  });
});

describe("graphEdge — ports routing (#2226, layered graphs)", () => {
  it("leaves the right edge at the vertical middle and enters the left edge (clean columnar flow)", () => {
    const g = graphEdge(A, B, { routing: "ports" });
    expect(g.d.startsWith("M 100 20 ")).toBe(true);  // right edge of A (x=100), no outset, vertical middle
    expect(g.d.endsWith("200 20")).toBe(true);        // straight to B's left port (x=200), no gap
  });

  it("puts the arrow tip on the target port with horizontal control handles", () => {
    const g = graphEdge(A, B, { routing: "ports" });
    expect(g.arrow.startsWith("M 200 20 ")).toBe(true); // tip at the left port
    // Control handles are horizontal (k=50): "M 100 20 C 150 20 150 20 200 20".
    expect(g.d).toBe("M 100 20 C 150 20 150 20 200 20");
  });

  it("routes ports differently from anchor for the same boxes", () => {
    expect(graphEdge(A, B, { routing: "ports" }).d).not.toBe(graphEdge(A, B).d);
  });
});
