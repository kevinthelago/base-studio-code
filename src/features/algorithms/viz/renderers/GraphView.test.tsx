// The `graph` renderer (#3224) — draws an SVG node-link diagram, stamps node marks + the transient
// visit/frontier verbs, and flashes the relaxed edge.
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { GraphView } from "./GraphView";
import { circularLayout } from "./graphLayout";
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
