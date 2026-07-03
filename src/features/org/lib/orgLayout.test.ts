import { describe, it, expect } from "vitest";
import { nodeBox, anchor, edgeGeometry, styleDash, clampZoom, autoLayout, NODE_SIZE, CANVAS_W, CANVAS_H } from "./orgLayout";
import { BUILTIN_ORGS, type Org, type Position } from "./org";

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

  it("clampZoom bounds the zoom range", () => {
    expect(clampZoom(0.1)).toBe(0.4);
    expect(clampZoom(9)).toBe(1.5);
    expect(clampZoom(0.8)).toBe(0.8);
  });
});

describe("autoLayout (#2199)", () => {
  it("places every node with a fresh x/y, deterministically", () => {
    const fleet = BUILTIN_ORGS.find((o) => o.id === "org-default-fleet")!;
    const a = autoLayout(fleet);
    const b = autoLayout(fleet);
    expect(Object.keys(a).sort()).toEqual(fleet.positions.map((p) => p.nodeId).sort());
    expect(a).toEqual(b); // deterministic — a re-runnable baseline
    // every coordinate is a finite number
    expect(Object.values(a).every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });

  it("layers a manager above the reports it manages", () => {
    const org: Org = {
      id: "x", name: "x",
      positions: [
        { nodeId: "boss", kind: "agent" }, { nodeId: "a", kind: "agent" }, { nodeId: "b", kind: "agent" },
      ],
      relationships: [
        { id: "e1", archetype: "manages", from: "boss", to: "a" },
        { id: "e2", archetype: "manages", from: "boss", to: "b" },
      ],
    };
    const layout = autoLayout(org);
    // The boss sits on a higher (smaller-y) row than its reports.
    expect(layout.boss.y).toBeLessThan(layout.a.y);
    expect(layout.boss.y).toBeLessThan(layout.b.y);
    // The two reports share a row.
    expect(layout.a.y).toBe(layout.b.y);
  });

  it("force-refines a real fleet into a non-overlapping graph that fits the design space", () => {
    const fleet = BUILTIN_ORGS.find((o) => o.id === "org-default-fleet")!;
    const layout = autoLayout(fleet);
    const boxes = fleet.positions.map((p) => ({ ...NODE_SIZE[p.kind], ...layout[p.nodeId] }));
    // The collision force guarantees breathing room — no two cards overlap.
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        const overlap = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
        expect(overlap).toBe(false);
      }
    }
    // The whole graph settles inside the 1120×800 design space (repulsion tuned to fit, not to overflow).
    expect(Math.max(...boxes.map((b) => b.x + b.w))).toBeLessThanOrEqual(CANVAS_W);
    expect(Math.max(...boxes.map((b) => b.y + b.h))).toBeLessThanOrEqual(CANVAS_H);
  });

  it("does not choke on a cycle", () => {
    const org: Org = {
      id: "c", name: "c",
      positions: [{ nodeId: "a", kind: "agent" }, { nodeId: "b", kind: "agent" }],
      relationships: [
        { id: "e1", archetype: "manages", from: "a", to: "b" },
        { id: "e2", archetype: "manages", from: "b", to: "a" },
      ],
    };
    expect(() => autoLayout(org)).not.toThrow();
    expect(Object.keys(autoLayout(org))).toHaveLength(2);
  });
});
