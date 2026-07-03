import { describe, it, expect } from "vitest";
import { nodeBox, anchor, edgeGeometry, styleDash, NODE_SIZE } from "./orgLayout";
import type { Position } from "./org";

describe("orgLayout geometry (#2193)", () => {
  it("nodeBox uses the position's x/y + the size for its kind", () => {
    const p: Position = { nodeId: "a", kind: "agent", x: 100, y: 50 };
    expect(nodeBox(p)).toEqual({ x: 100, y: 50, w: NODE_SIZE.agent.w, h: NODE_SIZE.agent.h });
    // A resource is smaller; an unplaced node sits at the origin.
    expect(nodeBox({ nodeId: "r", kind: "resource" })).toMatchObject({ x: 0, y: 0, w: NODE_SIZE.resource.w });
  });

  it("anchor lands on the box perimeter toward the target", () => {
    const box = { x: 0, y: 0, w: 100, h: 100 }; // center (50,50)
    // A target far to the right exits the right edge (x = w + 3 outset).
    const [x, y] = anchor(box, 500, 50);
    expect(x).toBeCloseTo(103, 0);
    expect(y).toBeCloseTo(50, 0);
  });

  it("edgeGeometry returns a cubic path + a label midpoint between the two boxes", () => {
    const A = { x: 0, y: 0, w: 100, h: 60 };
    const B = { x: 400, y: 0, w: 100, h: 60 };
    const g = edgeGeometry(A, B, 0);
    expect(g.d.startsWith("M ")).toBe(true);
    expect(g.d).toContain(" C "); // a cubic bezier
    // With no bow, the label sits on the straight line between the facing edges (y ≈ center 30).
    expect(g.ly).toBeCloseTo(30, 0);
    expect(g.lx).toBeGreaterThan(100);
    expect(g.lx).toBeLessThan(400);
  });

  it("a bow pushes the label off the straight line", () => {
    const A = { x: 0, y: 0, w: 100, h: 60 };
    const B = { x: 400, y: 0, w: 100, h: 60 };
    expect(edgeGeometry(A, B, 40).ly).not.toBeCloseTo(30, 0);
  });

  it("styleDash maps archetype styles to SVG dash arrays", () => {
    expect(styleDash("solid")).toBe("0");
    expect(styleDash("dashed")).toBe("7 5");
    expect(styleDash("gated")).toBe("3 5");
    expect(styleDash("dotted")).toBe("1 6");
  });
});
