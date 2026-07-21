// The `graph` renderer (#3224) — draws an SVG node-link diagram, stamps node marks + the transient
// visit/frontier verbs, and flashes the relaxed edge.
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { GraphView } from "./GraphView";
import { circularLayout, coordinateLayout, layoutFor } from "./graphLayout";
import type { GraphFrame } from "../../lib/trace";

const frame: GraphFrame = {
  structure: "graph",
  nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
  edges: [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
  ],
  ops: [
    { op: "relax", edge: ["a", "b"] },
    { op: "visit", node: "a" },
  ],
  marks: { a: "visited", b: "frontier" },
};

describe("GraphView (#3224)", () => {
  it("renders a node per id and an edge per pair, with labels", () => {
    const { container } = render(<GraphView frame={frame} />);
    expect(container.querySelectorAll("circle.graph-node").length).toBe(3);
    expect(container.querySelectorAll("line.graph-edge").length).toBe(2);
    expect([...container.querySelectorAll("text.graph-node-label")].map((t) => t.textContent)).toEqual(["a", "b", "c"]);
  });

  it("stamps durable node marks and the transient visit verb + relaxed edge", () => {
    const { container } = render(<GraphView frame={frame} />);
    expect(container.querySelectorAll('circle[data-mark="visited"]').length).toBe(1); // a
    expect(container.querySelectorAll('circle[data-mark="frontier"]').length).toBe(1); // b
    expect(container.querySelectorAll('circle[data-op="visit"]').length).toBe(1); // a is being visited
    // relax animates the EDGE, not its endpoint nodes.
    expect(container.querySelectorAll('line[data-op="relax"]').length).toBe(1);
    expect(container.querySelectorAll('circle[data-op="relax"]').length).toBe(0);
  });

  // #3378 — the visualization defect: an explored start node must still render as the origin. The two
  // durable axes are stamped as SEPARATE attributes, so the CSS can paint the visited fill and the start
  // ring on the same node instead of one erasing the other.
  it("stamps the start/goal role alongside the walker's mark, so a visited origin stays distinguishable", () => {
    const explored: GraphFrame = {
      ...frame,
      ops: undefined,
      marks: { a: "visited", b: "visited", c: "visited" }, // the whole graph explored …
      roles: { a: "start", c: "goal" }, // … and `a` is still the origin, `c` still the goal
    };
    const { container } = render(<GraphView frame={explored} />);
    const start = container.querySelector('circle[data-role="start"]');
    expect(start).not.toBeNull();
    expect(start?.getAttribute("data-mark")).toBe("visited"); // both facts on ONE node
    expect(container.querySelector('circle[data-role="goal"]')?.getAttribute("data-mark")).toBe("visited");
    // The middle node carries no role — it is only distinguishable BECAUSE the others do.
    expect(container.querySelectorAll("circle[data-role]").length).toBe(2);
  });
});

describe("circularLayout (#3224)", () => {
  it("places every id at a distinct position", () => {
    const pos = circularLayout(["a", "b", "c", "d"]);
    expect(Object.keys(pos)).toEqual(["a", "b", "c", "d"]);
    const points = Object.values(pos).map((p) => `${Math.round(p.x)},${Math.round(p.y)}`);
    expect(new Set(points).size).toBe(4); // all distinct
    expect(Object.values(pos).every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });
});

describe("coordinateLayout / layoutFor (#3228)", () => {
  it("uses node coordinates when all present (relative positions preserved), else null", () => {
    const pos = coordinateLayout([
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 10, y: 0 },
      { id: "c", x: 0, y: 10 },
    ]);
    expect(pos).not.toBeNull();
    expect(pos!.b.x).toBeGreaterThan(pos!.a.x); // b is to the right of a
    expect(pos!.c.y).toBeGreaterThan(pos!.a.y); // c is below a
    // not all nodes have coords → null (caller falls back to circular).
    expect(coordinateLayout([{ id: "a" }, { id: "b", x: 1, y: 1 }])).toBeNull();
  });

  it("layoutFor falls back to a circular layout when nodes have no coordinates", () => {
    const lf = layoutFor([{ id: "a" }, { id: "b" }, { id: "c" }]);
    expect(Object.keys(lf)).toEqual(["a", "b", "c"]);
    expect(Object.values(lf).every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });
});
