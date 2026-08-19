import { describe, it, expect } from "vitest";
import {
  buildGraph, focusSets, rollUpHealth, kitNodeId, usesKitEdgeId, NW,
  libraryNodeId, requiresEdgeId, libIdOfNode, isLibraryNode, libraryGraphOf, isLibraryEdge, LIBRARY_META,
  HEALTH_META, HEALTH_RANK, ACTIVITY_META, nodeStateWord,
  type GHealth, type GActivity,
  type GRawNode, type GRawEdge, showsBuildingPulse } from "@/features/glance/lib/glanceGraph";
import { buildGlanceData } from "@/features/glance/lib/glanceData";

const NODES: GRawNode[] = [
  { id: "core", role: "infra", health: "healthy", activity: "live" },
  { id: "api", role: "service", health: "healthy", activity: "building" },
  { id: "web", role: "client", health: "healthy", activity: "building" },
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
      [{ id: "a", role: "service", health: "healthy", activity: "building" }, { id: "b", role: "infra", health: "healthy", activity: "building" }],
      [{ from: "a", to: "b", kind: "events" }],
    );
    expect(g.edges[0].hard).toBe(false);
  });

  it("detects a mutual-dependency cycle and flags both edges + nodes", () => {
    const g = buildGraph(
      [{ id: "x", role: "data", health: "healthy", activity: "building" }, { id: "y", role: "data", health: "healthy", activity: "building" }],
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
    const nodes: GRawNode[] = ["p1", "p2", "c1", "c2", "c3"].map((id) => ({ id, role: "service" as const, health: "healthy" as const, activity: "building" as const }));
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

describe("buildGraph — fenced UI-kit band (#3007)", () => {
  // Two projects, both consuming one shared kit — the kit is edged FROM each project via `uses-kit`.
  const KIT = "react-ui";
  const withKit: GRawNode[] = [
    { id: "app-a", role: "service", health: "healthy", activity: "idle" },
    { id: "app-b", role: "service", health: "healthy", activity: "idle" },
    { id: kitNodeId(KIT), slug: "React UI", kind: "kit", role: "infra", health: "healthy", activity: "idle" },
  ];
  const kitEdges: GRawEdge[] = [
    { id: usesKitEdgeId("app-a", KIT), from: "app-a", to: kitNodeId(KIT), kind: "uses-kit" },
    { id: usesKitEdgeId("app-b", KIT), from: "app-b", to: kitNodeId(KIT), kind: "uses-kit" },
  ];

  it("lifts kit nodes into a fenced band RIGHT of every project node", () => {
    const g = buildGraph(withKit, kitEdges);
    expect(g.bandZone).toBeDefined();
    const band = g.bandZone!;
    const kits = g.nodes.filter((n) => n.kind === "kit");
    const projs = g.nodes.filter((n) => n.kind !== "kit");
    expect(kits).toHaveLength(1);
    for (const k of kits) {
      // every kit sits INSIDE the band column…
      expect(k.x).toBeGreaterThanOrEqual(band.x0);
      expect(k.x).toBeLessThanOrEqual(band.x1);
      expect(k.layer).toBe(-1); // sentinel: outside the project layering
    }
    // …and every project sits STRICTLY left of the fence.
    for (const p of projs) expect(p.x).toBeLessThan(band.x0);
  });

  it("leaves the project positions UNTOUCHED — a right-hand band displaces nothing", () => {
    // The old top band shifted every project DOWN by its divider to clear the row. A column past the
    // rightmost project occupies space the network never used, so the projects keep exactly the
    // coordinates the layout engine gave them. That is what makes the move purely additive.
    const bare = buildGraph(withKit.filter((n) => n.kind !== "kit"), []);
    const g = buildGraph(withKit, kitEdges);
    for (const b of bare.nodes) {
      const after = g.nodes.find((n) => n.id === b.id)!;
      expect([after.x, after.y]).toEqual([b.x, b.y]);
    }
  });

  it("routes each uses-kit edge with the columnar side-port, like every other edge", () => {
    // The band used to sit ABOVE, so a library edge ran vertically and fell back to the perimeter-anchor
    // router. With the band to the RIGHT every dimension is on one left→right axis, so there is no second
    // orientation left to special-case: the edge leaves the project's RIGHT face.
    const g = buildGraph(withKit, kitEdges);
    const kitEdgesOut = g.edges.filter((e) => e.kind === "uses-kit");
    expect(kitEdgesOut).toHaveLength(2);
    for (const e of kitEdgesOut) {
      expect(e.d.startsWith("M ") && e.arrow.startsWith("M ")).toBe(true);
      const src = g.nodes.find((n) => n.id === e.from)!;
      const startX = Number(/^M ([\d.]+) /.exec(e.d)![1]);
      expect(Math.abs(startX - (src.x + NW))).toBeLessThan(6);   // right face, not the top centre
    }
  });

  it("returns NO band and the exact pre-#3007 project layout when there are no kit nodes", () => {
    const g = buildGraph(NODES, EDGES);
    expect(g.bandZone).toBeUndefined();
    // Locked coordinates: the layered DAG places core/api/web left→right, all on one centred row —
    // byte-identical to before the kit-band scoping refactor.
    const layout = Object.fromEntries(g.nodes.map((n) => [n.id, [n.x, n.y]]));
    expect(layout).toEqual({ core: [70, 70], api: [322, 70], web: [574, 70] });
  });
});

describe("cross-graph library band (#3119) — generalized from the UI-kit band", () => {
  it("id + guard helpers: kit is the `ui` library graph, requires is a library edge", () => {
    // `ui` reuses the persisted `kit:` namespace — libraryNodeId("ui", …) IS kitNodeId(…).
    expect(libraryNodeId("ui", "react-ui")).toBe(kitNodeId("react-ui"));
    expect(libraryNodeId("ui", "react-ui")).toBe("kit:react-ui");
    expect(libraryNodeId("algo", "dijkstra")).toBe("algo:dijkstra");
    expect(libraryNodeId("sound", "chime")).toBe("sound:chime");
    expect(libIdOfNode("algo:dijkstra")).toBe("dijkstra");
    expect(libIdOfNode(kitNodeId("react-ui"))).toBe("react-ui");
    expect(requiresEdgeId("route-planner", libraryNodeId("algo", "dijkstra"))).toBe("req:route-planner>algo:dijkstra");

    expect(isLibraryNode({ kind: "kit" })).toBe(true);
    expect(isLibraryNode({ kind: "library" })).toBe(true);
    expect(isLibraryNode({ kind: "project" })).toBe(false);
    expect(isLibraryNode({})).toBe(false);

    expect(libraryGraphOf({ kind: "kit" })).toBe("ui");                       // back-compat: a kit is a ui node
    expect(libraryGraphOf({ kind: "library", library: "algo" })).toBe("algo");
    expect(libraryGraphOf({ kind: "library", library: "sound" })).toBe("sound");
    expect(libraryGraphOf({ kind: "library" })).toBe("ui");                   // defaults to ui
    expect(libraryGraphOf({ kind: "project" })).toBeUndefined();

    expect(isLibraryEdge("uses-kit")).toBe(true);
    expect(isLibraryEdge("requires")).toBe(true);
    expect(isLibraryEdge("api")).toBe(false);
    expect(isLibraryEdge("events")).toBe(false);

    // every graph has band presentation; the ui row is the exact pre-#3119 kit treatment.
    expect(LIBRARY_META.ui.bandLabel).toBe("UI KITS");
    expect(LIBRARY_META.algo.bandLabel).toBe("ALGORITHMS");
    expect(LIBRARY_META.sound.bandLabel).toBe("SOUNDS");
  });

  // A route-planner-style app: three project nodes, plus an ALGORITHM and a SOUND library node pulled in
  // via `requires` edges — the logistics example from the epic (a page requires algo:*/dijkstra).
  const ALGO = libraryNodeId("algo", "dijkstra"), SOUND = libraryNodeId("sound", "chime");
  const withLibs: GRawNode[] = [
    ...NODES,
    { id: ALGO, slug: "Dijkstra", kind: "library", library: "algo", role: "infra", health: "healthy", activity: "idle" },
    { id: SOUND, slug: "Chime", kind: "library", library: "sound", role: "infra", health: "healthy", activity: "idle" },
  ];
  const libEdges: GRawEdge[] = [
    ...EDGES,
    { id: requiresEdgeId("web", ALGO), from: "web", to: ALGO, kind: "requires" },
    { id: requiresEdgeId("api", SOUND), from: "api", to: SOUND, kind: "requires" },
  ];

  it("lifts algorithm + sound library nodes into the fenced band, as a column past the last project", () => {
    const g = buildGraph(withLibs, libEdges);
    // core/api/web lay out at x = 70/322/574, so the rightmost project's right edge is 574 + NW(186) = 760.
    // The fence clears that by 40; the cards clear the fence by 34.
    expect(g.bandZone).toEqual({ x0: 800, x1: 800 + 34 + NW + 40 });

    const libs = g.nodes.filter(isLibraryNode);
    expect(libs.map((n) => n.id)).toEqual([ALGO, SOUND]); // both library dimensions present, in order

    // ONE column: both cards share an x, stacked and centred on the projects' vertical span.
    for (const n of libs) {
      expect(n.layer).toBe(-1); // sentinel: outside the project layering
      expect(n.x).toBe(800 + 34);
    }
    // every project sits STRICTLY left of the fence.
    for (const p of g.nodes.filter((n) => !isLibraryNode(n))) expect(p.x).toBeLessThan(g.bandZone!.x0);
  });

  it("spreads the band column over the projects' vertical span, capped at one row gap", () => {
    // Two projects on separate rows give the column a real span to spread over; one row would collapse
    // the step to 0 and prove nothing about the spacing.
    const g = buildGraph(
      [
        { id: "a", role: "service", health: "healthy", activity: "idle" },
        { id: "b", role: "service", health: "healthy", activity: "idle" },
        { id: ALGO, slug: "Dijkstra", kind: "library", library: "algo", role: "infra", health: "healthy", activity: "idle" },
        { id: SOUND, slug: "Chime", kind: "library", library: "sound", role: "infra", health: "healthy", activity: "idle" },
      ],
      [
        { id: requiresEdgeId("a", ALGO), from: "a", to: ALGO, kind: "requires" },
        { id: requiresEdgeId("b", SOUND), from: "b", to: SOUND, kind: "requires" },
      ],
    );
    const libs = g.nodes.filter(isLibraryNode);
    expect(Math.abs(libs[1].y - libs[0].y)).toBeLessThanOrEqual(102); // ROWGAP cap
  });

  it("routes each requires edge with the columnar side-port (leaves the project's right face)", () => {
    // One app with two library deps in the band column to its right — a library edge is horizontal now,
    // so it takes the same side ports every project edge does.
    const g = buildGraph(
      [
        { id: "app", role: "service", health: "healthy", activity: "idle" },
        { id: ALGO, slug: "Dijkstra", kind: "library", library: "algo", role: "infra", health: "healthy", activity: "idle" },
        { id: SOUND, slug: "Chime", kind: "library", library: "sound", role: "infra", health: "healthy", activity: "idle" },
      ],
      [
        { id: requiresEdgeId("app", ALGO), from: "app", to: ALGO, kind: "requires" },
        { id: requiresEdgeId("app", SOUND), from: "app", to: SOUND, kind: "requires" },
      ],
    );
    const reqEdges = g.edges.filter((e) => e.kind === "requires");
    expect(reqEdges).toHaveLength(2);
    for (const e of reqEdges) {
      expect(e.d.startsWith("M ") && e.arrow.startsWith("M ")).toBe(true);
      // The library node sits to the RIGHT, so the edge leaves the project's right face — not the top
      // centre the perimeter-anchor router used when the band was above.
      const src = g.nodes.find((n) => n.id === e.from)!;
      const startX = Number(/^M ([\d.]+) /.exec(e.d)![1]);
      expect(Math.abs(startX - (src.x + NW))).toBeLessThan(6);
    }
  });

  it("holds MULTIPLE dimensions at once — a UI kit and an algorithm in the same band", () => {
    const nodes: GRawNode[] = [
      { id: "app", role: "service", health: "healthy", activity: "idle" },
      { id: kitNodeId("react-ui"), slug: "React UI", kind: "kit", role: "infra", health: "healthy", activity: "idle" },
      { id: libraryNodeId("algo", "fib"), slug: "Fibonacci", kind: "library", library: "algo", role: "infra", health: "healthy", activity: "idle" },
    ];
    const edges: GRawEdge[] = [
      { id: usesKitEdgeId("app", "react-ui"), from: "app", to: kitNodeId("react-ui"), kind: "uses-kit" },
      { id: requiresEdgeId("app", libraryNodeId("algo", "fib")), from: "app", to: libraryNodeId("algo", "fib"), kind: "requires" },
    ];
    const g = buildGraph(nodes, edges);
    expect(g.bandZone).toBeDefined();
    const libs = g.nodes.filter(isLibraryNode);
    expect(libs).toHaveLength(2);
    for (const l of libs) expect(l.layer).toBe(-1);
    // both the uses-kit and the requires edge render (excluded from the project layout).
    expect(g.edges.filter((e) => isLibraryEdge(e.kind))).toHaveLength(2);
    expect(g.nodes.find((n) => n.id === "app")!.x).toBeLessThan(g.bandZone!.x0);
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
      [{ id: "dep", health: "error" }, { id: "mid", health: "healthy" }, { id: "top", health: "healthy" }],
      chain,
    );
    expect(r.get("dep")).toEqual({ health: "error", inherited: false }); // the origin — not inherited
    expect(r.get("mid")).toEqual({ health: "error", inherited: true });  // depends on dep
    expect(r.get("top")).toEqual({ health: "error", inherited: true });  // transitively depends on dep
  });

  it("idle/healthy never propagate — a healthy dependency leaves the dependent's own resting state", () => {
    const r = rollUpHealth(
      [{ id: "dep", health: "healthy" }, { id: "mid", health: "healthy" }],
      [{ from: "mid", to: "dep" }],
    );
    expect(r.get("mid")).toEqual({ health: "healthy", inherited: false });
  });

  it("`modifying` never propagates — a busy dependency must not make its dependents look degraded (#4052)", () => {
    // Rank 0, the same as `complete`: work being in flight is the NORMAL state of a live project, and a
    // dependency that is merely busy is not a problem anyone has to act on.
    expect(HEALTH_RANK.modifying).toBe(0);
    const r = rollUpHealth(
      [{ id: "dep", health: "modifying" }, { id: "top", health: "healthy" }],
      [{ from: "top", to: "dep" }],
    );
    expect(r.get("top")).toEqual({ health: "healthy", inherited: false });
    expect(r.get("dep")).toEqual({ health: "modifying", inherited: false }); // keeps its own state
  });

  it("takes the WORST severity across dependencies (error beats warning)", () => {
    const r = rollUpHealth(
      [{ id: "a", health: "warning" }, { id: "b", health: "error" }, { id: "top", health: "healthy" }],
      [{ from: "top", to: "a" }, { from: "top", to: "b" }],
    );
    expect(r.get("top")).toEqual({ health: "error", inherited: true });
  });

  it("is cycle-safe (a↔b does not loop forever)", () => {
    const r = rollUpHealth(
      [{ id: "a", health: "error" }, { id: "b", health: "healthy" }],
      [{ from: "a", to: "b" }, { from: "b", to: "a" }],
    );
    expect(r.get("a")!.health).toBe("error");
    expect(r.get("b")!.health).toBe("error"); // b depends on a (error) → inherits
  });

  it("is cycle-safe on a LONGER loop (a→b→c→a, the #2578 N-cycle vision)", () => {
    const r = rollUpHealth(
      [{ id: "a", health: "warning" }, { id: "b", health: "healthy" }, { id: "c", health: "healthy" }],
      [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "a" }],
    );
    // every node transitively reaches a's warning around the loop — and it terminates
    expect(r.get("a")!.health).toBe("warning");
    expect(r.get("b")!.health).toBe("warning");
    expect(r.get("c")!.health).toBe("warning");
  });

  it("buildGraph flags a cyclical iterates loop as a cycle and still lays out (#2578)", () => {
    const g = buildGraph(
      [{ id: "aud", role: "data", health: "healthy", activity: "review" }, { id: "rev", role: "data", health: "healthy", activity: "review" }],
      [{ from: "aud", to: "rev", kind: "data", archetype: "iterates" }, { from: "rev", to: "aud", kind: "data", archetype: "iterates" }],
    );
    expect(g.edges.every((e) => e.isCycle)).toBe(true);
    expect(g.cycleNodeIds.has("aud") && g.cycleNodeIds.has("rev")).toBe(true);
    expect(g.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
  });

  it("buildGraph stamps rollupHealth + healthInherited onto every node", () => {
    const g = buildGraph(
      [{ id: "dep", role: "data", health: "error", activity: "building" }, { id: "app", role: "client", health: "healthy", activity: "building" }],
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

describe("off health status (#3239) — the user's manual deactivate", () => {
  it("HEALTH_META + HEALTH_RANK carry a greyed, non-propagating 'off'", () => {
    expect(HEALTH_META.off).toMatchObject({ label: "off", pulse: false });
    expect(HEALTH_META.off.color).toContain("graph-health-off");
    expect(HEALTH_RANK.off).toBe(0); // rank 0 → never propagates up a dependency chain
  });

  it("rollUpHealth keeps an OFF node off even when a dependency is in error (the mute wins)", () => {
    const r = rollUpHealth(
      [{ id: "dep", health: "error" }, { id: "app", health: "off" }],
      [{ from: "app", to: "dep" }], // app depends on the errored dep
    );
    expect(r.get("app")).toEqual({ health: "off", inherited: false });
    expect(r.get("dep")).toEqual({ health: "error", inherited: false }); // the dep itself is untouched
  });

  it("an OFF node never propagates its state to a dependent (rank 0)", () => {
    const r = rollUpHealth(
      [{ id: "muted", health: "off" }, { id: "app", health: "healthy" }],
      [{ from: "app", to: "muted" }], // app depends on the off node
    );
    expect(r.get("app")).toEqual({ health: "healthy", inherited: false });
  });

  it("buildGraph stamps rollupHealth 'off' onto a deactivated node", () => {
    const g = buildGraph([{ id: "a", role: "service", health: "off", activity: "building" }], []);
    expect(g.nodes[0].rollupHealth).toBe("off");
    expect(g.nodes[0].healthInherited).toBe(false);
  });
});

describe("nodeStateWord (#3957)", () => {
  const n = (health: GHealth, activity: GActivity, rollupHealth?: GHealth) =>
    ({ health, activity, rollupHealth: rollupHealth ?? health });

  it("a degraded node reads its HEALTH word, never its reason", () => {
    // The bug: the slot is 108px/nowrap/ellipsis, so a reason didn't overflow — it truncated.
    // "waiting on 2 upstreams to land (domain-model…" rendered as "waiting on 2 upstre…".
    expect(nodeStateWord(n("warning", "building"))).toBe("warning");
    expect(nodeStateWord(n("error", "idle"))).toBe("error");
  });

  it("a healthy node still reads its ACTIVITY word", () => {
    expect(nodeStateWord(n("healthy", "building"))).toBe(ACTIVITY_META.building.label);
    expect(nodeStateWord(n("healthy", "waiting"))).toBe(ACTIVITY_META.waiting.label);
  });

  it("a deactivated node keeps its own word — the DIMMING says it is off (#4034)", () => {
    // #3239 spent the node's one word slot on "off". But a deactivated node is already dimmed in place
    // (`offOpacity`), so the word was redundant — and it cost the more useful fact: a node that was off
    // AND complete read "off" and lost the completion entirely. The dimming carries deactivation now;
    // the word carries what the node IS.
    expect(nodeStateWord(n("healthy", "building", "off"))).toBe(ACTIVITY_META.building.label);
    expect(nodeStateWord(n("healthy", "complete", "off"))).toBe(ACTIVITY_META.complete.label);
    // A node that is off AND genuinely degraded still reports the fault — that outranks activity.
    expect(nodeStateWord(n("error", "idle", "off"))).toBe(HEALTH_META.error.label);
  });

  it("a node degraded only by a DEPENDENCY keeps its own word", () => {
    // `health` is the node's own axis; `rollupHealth` folds in dependencies. A healthy node must not
    // read "warning" because something upstream is degraded — that is what the rollup DOT is for.
    expect(nodeStateWord(n("healthy", "building", "warning"))).toBe(ACTIVITY_META.building.label);
  });

  it("only ever returns a FIXED label — never free text", () => {
    // The real invariant. Not "one word": `ACTIVITY_META` legitimately carries "in review". What must
    // never happen is a `reason` (or any other caller-supplied string) reaching this slot, because the
    // slot truncates at 108px and free text becomes an unreadable fragment.
    const known = new Set([
      ...Object.values(HEALTH_META).map((m) => m.label),
      ...Object.values(ACTIVITY_META).map((m) => m.label),
    ]);
    const healths: GHealth[] = Object.keys(HEALTH_META) as GHealth[];   // #4042: derive, so a new/removed state is covered automatically
    const acts: GActivity[] = Object.keys(ACTIVITY_META) as GActivity[];
    for (const h of healths) for (const a of acts) {
      for (const roll of [undefined, ...healths]) {
        expect(known).toContain(nodeStateWord(n(h, a, roll)));
      }
    }
  });
});

describe("showsBuildingPulse (#4015)", () => {
  const ctx = { fleet: true, isOff: false, isError: false };

  it("pulses a building WORKER and nothing else", () => {
    expect(showsBuildingPulse({ activity: "building" }, ctx)).toBe(true);
    for (const a of ["idle", "planning", "waiting", "review", "live"] as const) {
      expect(showsBuildingPulse({ activity: a }, ctx)).toBe(false);
    }
  });

  it("stops when the worker parks into maintenance", () => {
    // Maintenance resolves to plain `idle` (agentStall), so the pulse stopping falls straight out of
    // the activity — which is why this keys on activity rather than on a separate flag.
    expect(showsBuildingPulse({ activity: "idle" }, ctx)).toBe(false);
  });

  it("NEVER animates an L0 project node, however busy the project is", () => {
    // The reason this is a prop and not `n.category`: an unclassified project has no category either,
    // so inferring would animate exactly the L0 nodes it was meant to exclude.
    expect(showsBuildingPulse({ activity: "building" }, { ...ctx, fleet: false })).toBe(false);
  });

  it("yields to error and stays off a deactivated node", () => {
    expect(showsBuildingPulse({ activity: "building" }, { ...ctx, isError: true })).toBe(false);
    expect(showsBuildingPulse({ activity: "building" }, { ...ctx, isOff: true })).toBe(false);
  });
});
