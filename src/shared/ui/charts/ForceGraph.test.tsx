import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ForceGraph } from "./ForceGraph";
import { forceLayout, type ForceGraphNode, type ForceGraphLink } from "./forceLayout";

const NODES: ForceGraphNode[] = [
  { id: "a", label: "core", group: 0 },
  { id: "b", label: "api", group: 1 },
  { id: "c", label: "ui", group: 2 },
  { id: "d", label: "db", group: 0 },
  { id: "e", label: "auth", group: 3 },
];
const LINKS: ForceGraphLink[] = [
  { source: "a", target: "b" },
  { source: "a", target: "c" },
  { source: "b", target: "d" },
  { source: "c", target: "e" },
  { source: "e", target: "a" },
];

describe("forceLayout (#2820) — a real, deterministic d3-force layout", () => {
  it("is deterministic — two runs of the same input produce identical positions", () => {
    const a = forceLayout(NODES, LINKS, 320, 220);
    const b = forceLayout(NODES, LINKS, 320, 220);
    expect(a.nodes).toEqual(b.nodes);
    expect(a.links).toEqual(b.links);
  });

  it("fits every node inside the frame and resolves link endpoints to node positions", () => {
    const { nodes, links } = forceLayout(NODES, LINKS, 320, 220);
    expect(nodes).toHaveLength(NODES.length);
    for (const nd of nodes) {
      expect(nd.x).toBeGreaterThanOrEqual(0);
      expect(nd.x).toBeLessThanOrEqual(320);
      expect(nd.y).toBeGreaterThanOrEqual(0);
      expect(nd.y).toBeLessThanOrEqual(220);
    }
    // One line per (resolvable) link, and each endpoint coincides with a placed node.
    expect(links).toHaveLength(LINKS.length);
    const pts = new Set(nodes.map((n) => `${n.x},${n.y}`));
    for (const l of links) {
      expect(pts.has(`${l.x1},${l.y1}`)).toBe(true);
      expect(pts.has(`${l.x2},${l.y2}`)).toBe(true);
    }
  });

  it("drops links that reference an unknown node id", () => {
    const { links } = forceLayout(NODES, [...LINKS, { source: "a", target: "ghost" }], 320, 220);
    expect(links).toHaveLength(LINKS.length); // the ghost link is filtered out
  });

  it("renders real SVG — a line per link and a circle per node", () => {
    const { container } = render(<ForceGraph nodes={NODES} links={LINKS} />);
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelectorAll("line")).toHaveLength(LINKS.length);
    expect(container.querySelectorAll("circle")).toHaveLength(NODES.length);
  });
});
