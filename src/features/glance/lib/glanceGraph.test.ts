import { describe, it, expect } from "vitest";
import {
  buildGraph, focusSets, rollUpHealth, kitNodeId, usesKitEdgeId, NW, NH,
  libraryNodeId, requiresEdgeId, libIdOfNode, isLibraryNode, libraryGraphOf, isLibraryEdge, LIBRARY_META,
  HEALTH_META, HEALTH_RANK, ACTIVITY_META, nodeStateWord,
  type GHealth, type GActivity,
  type GRawNode, type GRawEdge, showsBuildingPulse } from "./glanceGraph";
import { layoutBand } from "@/shared/lib/graph/crossGraph";
import { buildGlanceData } from "./glanceData";

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

  it("lifts kit nodes into a fenced top band, strictly above every project node", () => {
    const g = buildGraph(withKit, kitEdges);
    expect(g.kitBand).toBeDefined();
    const band = g.kitBand!;
    const kits = g.nodes.filter((n) => n.kind === "kit");
    const projs = g.nodes.filter((n) => n.kind !== "kit");
    expect(kits).toHaveLength(1);
    for (const k of kits) {
      // every kit sits INSIDE the band…
      expect(k.y).toBeGreaterThanOrEqual(band.y0);
      expect(k.y).toBeLessThanOrEqual(band.y1);
      expect(k.layer).toBe(-1); // sentinel: outside the project layering
    }
    // …and every project sits STRICTLY below the fence.
    for (const p of projs) expect(p.y).toBeGreaterThan(band.y1);
  });

  it("routes each uses-kit edge with the perimeter-anchor router (not the columnar side-port)", () => {
    const g = buildGraph(withKit, kitEdges);
    const kitEdgesOut = g.edges.filter((e) => e.kind === "uses-kit");
    expect(kitEdgesOut).toHaveLength(2);
    for (const e of kitEdgesOut) {
      expect(e.d.startsWith("M ") && e.arrow.startsWith("M ")).toBe(true);
      // The perimeter-anchor router leaves the source's TOP face at the box's horizontal CENTRE (the kit
      // sits directly above), NOT the left/right side-port a layered edge would use.
      const src = g.nodes.find((n) => n.id === e.from)!;
      const startX = Number(/^M ([\d.]+) /.exec(e.d)![1]);
      expect(Math.abs(startX - (src.x + NW / 2))).toBeLessThan(6);
    }
  });

  it("returns NO band and the exact pre-#3007 project layout when there are no kit nodes", () => {
    const g = buildGraph(NODES, EDGES);
    expect(g.kitBand).toBeUndefined();
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

  it("lifts algorithm + sound library nodes into the fenced band, laid out via A's layoutBand", () => {
    const g = buildGraph(withLibs, libEdges);
    // The band's vertical extent is topPad(40) + NH(66) + gap(34) = 140 (from the shared layoutBand math).
    expect(g.kitBand).toEqual({ y0: 0, y1: 140 });

    const libs = g.nodes.filter(isLibraryNode);
    expect(libs.map((n) => n.id)).toEqual([ALGO, SOUND]); // both library dimensions present, in order

    // Positions come straight from A's layoutBand over the project span [70, projMaxX=574] (core/api/web).
    const expected = layoutBand(2, { spanX0: 70, spanX1: 574, topPad: 40, nodeH: NH, gap: 34, maxStep: 252 });
    libs.forEach((n, i) => {
      expect(n.layer).toBe(-1); // sentinel: outside the project layering
      expect(n.x).toBeCloseTo(expected.positions[i].x);
      expect(n.y).toBe(expected.positions[i].y);
    });

    // every project sits STRICTLY below the fence (shifted down by the divider).
    for (const p of g.nodes.filter((n) => !isLibraryNode(n))) expect(p.y).toBeGreaterThan(g.kitBand!.y1);
  });

  it("routes each requires edge vertically with the perimeter-anchor router (leaves the project's top face)", () => {
    // One app directly below its two library deps (the aligned single-consumer case, like the kit-band
    // test) so the perimeter-anchor router is unambiguous — the band sits straight above the project.
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
      // The library node sits above; the edge leaves the project's TOP face at the box's horizontal centre
      // (the perimeter-anchor router), NOT the left/right side-port a layered project edge would use.
      const src = g.nodes.find((n) => n.id === e.from)!;
      const startX = Number(/^M ([\d.]+) /.exec(e.d)![1]);
      expect(Math.abs(startX - (src.x + NW / 2))).toBeLessThan(6);
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
    expect(g.kitBand).toBeDefined();
    const libs = g.nodes.filter(isLibraryNode);
    expect(libs).toHaveLength(2);
    for (const l of libs) expect(l.layer).toBe(-1);
    // both the uses-kit and the requires edge render (excluded from the project layout, routed vertically).
    expect(g.edges.filter((e) => isLibraryEdge(e.kind))).toHaveLength(2);
    expect(g.nodes.find((n) => n.id === "app")!.y).toBeGreaterThan(g.kitBand!.y1);
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
