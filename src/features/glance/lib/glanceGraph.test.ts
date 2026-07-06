import { describe, it, expect } from "vitest";
import { buildGraph, focusSets, type GRawNode, type GRawEdge } from "./glanceGraph";
import { buildGlanceData } from "./glanceData";

const NODES: GRawNode[] = [
  { id: "core", role: "infra", status: "done" },
  { id: "api", role: "service", status: "building" },
  { id: "web", role: "client", status: "idle" },
];
const EDGES: GRawEdge[] = [
  { from: "api", to: "core", kind: "api" },
  { from: "web", to: "api", kind: "api" },
];

describe("buildGraph (#2206)", () => {
  it("layers by dependency depth (a provider sits left of its consumer)", () => {
    const g = buildGraph(NODES, EDGES);
    const layer = Object.fromEntries(g.nodes.map((n) => [n.id, n.layer]));
    // core is foundational (layer 0); api depends on core (1); web depends on api (2).
    expect(layer.core).toBe(0);
    expect(layer.api).toBe(1);
    expect(layer.web).toBe(2);
    // x increases with layer (left→right flow).
    const x = Object.fromEntries(g.nodes.map((n) => [n.id, n.x]));
    expect(x.core).toBeLessThan(x.api);
    expect(x.api).toBeLessThan(x.web);
  });

  it("hard vs soft: api/data are hard, events are soft", () => {
    const g = buildGraph(
      [{ id: "a", role: "service", status: "idle" }, { id: "b", role: "infra", status: "idle" }],
      [{ from: "a", to: "b", kind: "events" }],
    );
    expect(g.edges[0].hard).toBe(false);
  });

  it("detects a mutual-dependency cycle and flags both edges + nodes", () => {
    const g = buildGraph(
      [{ id: "x", role: "data", status: "idle" }, { id: "y", role: "data", status: "idle" }],
      [{ from: "x", to: "y", kind: "data" }, { from: "y", to: "x", kind: "data" }],
    );
    expect(g.cyclePairs).toHaveLength(1);
    expect(g.cycleNodeIds.has("x") && g.cycleNodeIds.has("y")).toBe(true);
    expect(g.edges.every((e) => e.isCycle)).toBe(true);
    // still lays out (doesn't diverge on the cycle)
    expect(g.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
  });

  it("emits an SVG path + arrow per edge", () => {
    const g = buildGraph(NODES, EDGES);
    expect(g.edges.every((e) => e.d.startsWith("M ") && e.arrow.startsWith("M "))).toBe(true);
  });

  it("drops self-loops and edges to unknown nodes", () => {
    const g = buildGraph(NODES, [{ from: "api", to: "api", kind: "api" }, { from: "api", to: "ghost", kind: "api" }]);
    expect(g.edges).toHaveLength(0);
  });

  it("orders a layer by the barycenter of its neighbors (shared orderLayers, #2418 — parity baseline)", () => {
    // p1/p2 are layer-0 providers; c1/c3 depend on p2, c2 on p1. The pre-#2418 inline barycenter
    // (6 snapshot passes) settled the consumer column as [c2, c1, c3] — locked here as the parity order.
    const nodes: GRawNode[] = ["p1", "p2", "c1", "c2", "c3"].map((id) => ({ id, role: "service" as const, status: "idle" as const }));
    const edges: GRawEdge[] = [
      { from: "c1", to: "p2", kind: "api" },
      { from: "c2", to: "p1", kind: "api" },
      { from: "c3", to: "p2", kind: "api" },
    ];
    const g = buildGraph(nodes, edges);
    const y = Object.fromEntries(g.nodes.map((n) => [n.id, n.y]));
    expect(y.c2).toBeLessThan(y.c1);
    expect(y.c1).toBeLessThan(y.c3);
  });
});

describe("focusSets (#2206)", () => {
  const g = buildGraph(NODES, EDGES);
  it("a focused node lights itself + neighbors + connecting edges", () => {
    const f = focusSets(g, "api", null, false)!;
    expect(f.nodes.has("api") && f.nodes.has("core") && f.nodes.has("web")).toBe(true);
    expect(f.edges.size).toBe(2);
  });
  it("a focused edge lights just its two endpoints", () => {
    const e = g.edges.find((x) => x.from === "web")!;
    const f = focusSets(g, null, e.id, false)!;
    expect([...f.nodes].sort()).toEqual(["api", "web"]);
  });
  it("nothing focused → null (everything lit)", () => {
    expect(focusSets(g, null, null, false)).toBeNull();
  });
});

describe("buildGlanceData (#2206 / #2253 / #2272)", () => {
  it("returns an EMPTY, non-sample graph when there are no projects — a real empty state, not the mock (#2272)", () => {
    const d = buildGlanceData([]);
    expect(d.rawNodes).toEqual([]);
    expect(d.rawEdges).toEqual([]);
    expect(d.sample).toBe(false);
  });
  it("uses real projects as nodes (derived role, idle status) and NEVER fabricates a topology", () => {
    const projects = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, name: `Project ${i}` }));
    const data = buildGlanceData(projects);
    expect(data.rawNodes.map((n) => n.id).sort()).toEqual(projects.map((p) => p.id).sort());
    expect(data.rawNodes.every((n) => n.slug?.startsWith("Project"))).toBe(true);
    expect(data.sample).toBe(false);
    expect(data.rawEdges).toEqual([]); // no links passed → no edges (no invented dependencies)
  });
  it("renders only the user-drawn links as edges, filtered to links between existing nodes (#2253)", () => {
    const projects = [{ id: "a", name: "A" }, { id: "b", name: "B" }];
    const data = buildGlanceData(projects, [
      { id: "l1", from: "a", to: "b", kind: "api" },
      { id: "l2", from: "a", to: "gone", kind: "data" }, // dangling target → dropped
    ]);
    expect(data.rawEdges.map((e) => e.id)).toEqual(["l1"]);
    expect(data.sample).toBe(false);
  });
});
