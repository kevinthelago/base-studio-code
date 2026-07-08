import { describe, it, expect } from "vitest";
import { buildGraph, focusSets, rollUpHealth, type GRawNode, type GRawEdge } from "./glanceGraph";
import { buildGlanceData } from "./glanceData";

const NODES: GRawNode[] = [
  { id: "core", role: "infra", health: "healthy", activity: "live" },
  { id: "api", role: "service", health: "healthy", activity: "building" },
  { id: "web", role: "client", health: "idle", activity: "building" },
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
      [{ id: "a", role: "service", health: "idle", activity: "building" }, { id: "b", role: "infra", health: "idle", activity: "building" }],
      [{ from: "a", to: "b", kind: "events" }],
    );
    expect(g.edges[0].hard).toBe(false);
  });

  it("detects a mutual-dependency cycle and flags both edges + nodes", () => {
    const g = buildGraph(
      [{ id: "x", role: "data", health: "idle", activity: "building" }, { id: "y", role: "data", health: "idle", activity: "building" }],
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
    const nodes: GRawNode[] = ["p1", "p2", "c1", "c2", "c3"].map((id) => ({ id, role: "service" as const, health: "idle" as const, activity: "building" as const }));
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

describe("rollUpHealth (#2541) — warnings/errors propagate up the dependency chain", () => {
  // top → mid → dep  (`from depends on to`), so dep is the deepest dependency.
  const chain = [{ from: "mid", to: "dep" }, { from: "top", to: "mid" }];

  it("an error on a dependency surfaces on every dependent, marked inherited", () => {
    const r = rollUpHealth(
      [{ id: "dep", health: "error" }, { id: "mid", health: "healthy" }, { id: "top", health: "idle" }],
      chain,
    );
    expect(r.get("dep")).toEqual({ health: "error", inherited: false }); // the origin — not inherited
    expect(r.get("mid")).toEqual({ health: "error", inherited: true });  // depends on dep
    expect(r.get("top")).toEqual({ health: "error", inherited: true });  // transitively depends on dep
  });

  it("idle/healthy never propagate — a healthy dependency leaves the dependent's own resting state", () => {
    const r = rollUpHealth(
      [{ id: "dep", health: "healthy" }, { id: "mid", health: "idle" }],
      [{ from: "mid", to: "dep" }],
    );
    expect(r.get("mid")).toEqual({ health: "idle", inherited: false });
  });

  it("takes the WORST severity across dependencies (error beats warning)", () => {
    const r = rollUpHealth(
      [{ id: "a", health: "warning" }, { id: "b", health: "error" }, { id: "top", health: "idle" }],
      [{ from: "top", to: "a" }, { from: "top", to: "b" }],
    );
    expect(r.get("top")).toEqual({ health: "error", inherited: true });
  });

  it("is cycle-safe (a↔b does not loop forever)", () => {
    const r = rollUpHealth(
      [{ id: "a", health: "error" }, { id: "b", health: "idle" }],
      [{ from: "a", to: "b" }, { from: "b", to: "a" }],
    );
    expect(r.get("a")!.health).toBe("error");
    expect(r.get("b")!.health).toBe("error"); // b depends on a (error) → inherits
  });

  it("is cycle-safe on a LONGER loop (a→b→c→a, the #2578 N-cycle vision)", () => {
    const r = rollUpHealth(
      [{ id: "a", health: "warning" }, { id: "b", health: "idle" }, { id: "c", health: "idle" }],
      [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "a" }],
    );
    // every node transitively reaches a's warning around the loop — and it terminates
    expect(r.get("a")!.health).toBe("warning");
    expect(r.get("b")!.health).toBe("warning");
    expect(r.get("c")!.health).toBe("warning");
  });

  it("buildGraph flags a cyclical iterates loop as a cycle and still lays out (#2578)", () => {
    const g = buildGraph(
      [{ id: "aud", role: "data", health: "idle", activity: "review" }, { id: "rev", role: "data", health: "idle", activity: "review" }],
      [{ from: "aud", to: "rev", kind: "data", archetype: "iterates" }, { from: "rev", to: "aud", kind: "data", archetype: "iterates" }],
    );
    expect(g.edges.every((e) => e.isCycle)).toBe(true);
    expect(g.cycleNodeIds.has("aud") && g.cycleNodeIds.has("rev")).toBe(true);
    expect(g.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
  });

  it("buildGraph stamps rollupHealth + healthInherited onto every node", () => {
    const g = buildGraph(
      [{ id: "dep", role: "data", health: "error", activity: "building" }, { id: "app", role: "client", health: "idle", activity: "building" }],
      [{ from: "app", to: "dep", kind: "api" }],
    );
    const app = g.nodes.find((n) => n.id === "app")!;
    expect(app.rollupHealth).toBe("error");
    expect(app.healthInherited).toBe(true);
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
