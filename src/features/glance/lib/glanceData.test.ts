import { describe, it, expect } from "vitest";
import { SAMPLE_GRAPH, buildGlanceData } from "./glanceData";
import { kitNodeId, usesKitEdgeId, libraryNodeId, requiresEdgeId } from "./glanceGraph";
// Cross-feature via the barrel (#1309): the REAL kit→library roll-up + the component record it reads.
import { resolveKitLibraryRefs, type ComponentRecord } from "@/features/designs";

// Guard for the externalized sample network (@data/glance/sample-graph.json, #2419).
describe("SAMPLE_GRAPH (loaded from @data/glance/sample-graph.json)", () => {
  it("is the 14-node / 20-edge Northwind spine, flagged sample", () => {
    expect(SAMPLE_GRAPH.sample).toBe(true);
    expect(SAMPLE_GRAPH.rawNodes).toHaveLength(14);
    expect(SAMPLE_GRAPH.rawEdges).toHaveLength(20);
  });

  it("is referentially intact — every edge endpoint is a node, every node id unique", () => {
    const ids = new Set(SAMPLE_GRAPH.rawNodes.map((n) => n.id));
    expect(ids.size).toBe(SAMPLE_GRAPH.rawNodes.length);
    for (const e of SAMPLE_GRAPH.rawEdges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
  });

  it("carries only valid role / health / activity / edge-kind tokens (#2541)", () => {
    const roles = ["infra", "service", "data", "client"];
    const healths = ["idle", "healthy", "warning", "error"];
    const activities = ["idle", "planning", "building", "waiting", "review", "live"];
    const kinds = ["api", "data", "events"];
    for (const n of SAMPLE_GRAPH.rawNodes) {
      expect(roles).toContain(n.role);
      expect(healths).toContain(n.health);
      expect(activities).toContain(n.activity);
    }
    for (const e of SAMPLE_GRAPH.rawEdges) expect(kinds).toContain(e.kind);
  });

  it("keeps the spec's reporting⇄analytics dependency cycle (the coordination-hazard example)", () => {
    const has = (from: string, to: string) => SAMPLE_GRAPH.rawEdges.some((e) => e.from === from && e.to === to);
    expect(has("reporting", "analytics")).toBe(true);
    expect(has("analytics", "reporting")).toBe(true);
  });
});

describe("buildGlanceData", () => {
  it("zero projects yields an EMPTY real graph — never the sample (#2272)", () => {
    const g = buildGlanceData([]);
    expect(g.sample).toBe(false);
    expect(g.rawNodes).toHaveLength(0);
    expect(g.rawEdges).toHaveLength(0);
  });

  it("carries a project's LIFECYCLE category onto the node — no more hash-per-id tier (#2583)", () => {
    const g = buildGlanceData([{ id: "p", name: "P", category: "transform" }]);
    expect(g.rawNodes[0].category).toBe("transform");
    // the same project id always yields the same node (was hash-derived role before) — deterministic
    expect(buildGlanceData([{ id: "p", name: "P", category: "transform" }]).rawNodes[0]).toEqual(g.rawNodes[0]);
  });
});

describe("buildGlanceData — UI-kit nodes (#2571)", () => {
  const projects = [{ id: "app-a", name: "App A" }, { id: "app-b", name: "App B" }];
  const kits = [{ id: "react-ui", name: "React UI" }];

  it("adds ONE kit node per distinct kit in use + one kit→project edge per consumer", () => {
    const g = buildGlanceData(projects, [], [
      { projectKey: "app-a", kitId: "react-ui" },
      { projectKey: "app-b", kitId: "react-ui" },
    ], kits);
    const kitNode = g.rawNodes.find((n) => n.kind === "kit");
    expect(kitNode).toMatchObject({ id: kitNodeId("react-ui"), kind: "kit", slug: "React UI", health: "idle", activity: "idle" });
    // exactly one kit node (two consumers of the SAME kit ⇒ one node)
    expect(g.rawNodes.filter((n) => n.kind === "kit")).toHaveLength(1);
    // one edge per consumer, project→kit, kind "uses-kit"
    const kitEdges = g.rawEdges.filter((e) => e.kind === "uses-kit");
    expect(kitEdges).toEqual([
      { id: usesKitEdgeId("app-a", "react-ui"), from: "app-a", to: kitNodeId("react-ui"), kind: "uses-kit" },
      { id: usesKitEdgeId("app-b", "react-ui"), from: "app-b", to: kitNodeId("react-ui"), kind: "uses-kit" },
    ]);
  });

  it("leaves the PROJECT nodes untouched — no `kind`, same shape as without kit usage", () => {
    const withKits = buildGlanceData(projects, [], [{ projectKey: "app-a", kitId: "react-ui" }], kits);
    const without = buildGlanceData(projects);
    const projA = withKits.rawNodes.find((n) => n.id === "app-a");
    expect(projA?.kind).toBeUndefined();
    expect(projA).toEqual(without.rawNodes.find((n) => n.id === "app-a"));
  });

  it("emits NO kit node for a kit whose only consumer isn't a project in this graph (stale usage)", () => {
    const g = buildGlanceData(projects, [], [{ projectKey: "ghost", kitId: "react-ui" }], kits);
    expect(g.rawNodes.some((n) => n.kind === "kit")).toBe(false);
    expect(g.rawEdges.some((e) => e.kind === "uses-kit")).toBe(false);
  });

  it("dedupes a duplicate (projectKey, kitId) into a single edge", () => {
    const g = buildGlanceData(projects, [], [
      { projectKey: "app-a", kitId: "react-ui" },
      { projectKey: "app-a", kitId: "react-ui" },
    ], kits);
    expect(g.rawEdges.filter((e) => e.kind === "uses-kit")).toHaveLength(1);
  });

  it("falls back to the kit ID when the kit library has no matching name", () => {
    const g = buildGlanceData(projects, [], [{ projectKey: "app-a", kitId: "mystery-kit" }], []);
    expect(g.rawNodes.find((n) => n.kind === "kit")?.slug).toBe("mystery-kit");
  });

  it("adds nothing when there is no kit usage (identical to before #2571)", () => {
    const g = buildGlanceData(projects, [], [], kits);
    expect(g.rawNodes.some((n) => n.kind === "kit")).toBe(false);
    expect(g.rawEdges).toEqual([]);
  });
});

// The REAL cross-graph data path (#3133) — not synthetic band input: a genuine ComponentRecord whose source
// imports `@bsc/algorithms/fibonacci` is resolved by the designs feature's roll-up against the PACKAGED
// algorithm seed, then joined against kit usage here. This is the wiring #3133 exists to add; #3119 only
// ever exercised hand-written `requires` fixtures.
describe("buildGlanceData — cross-graph `requires` from REAL library refs (#3133)", () => {
  const projects = [{ id: "route-planner", name: "Route Planner" }, { id: "app-b", name: "App B" }];
  const kits = [{ id: "react-ui", name: "React UI" }];
  const comp = (id: string, source: string, kitId = "react-ui"): ComponentRecord => ({
    id, name: id, kitId, role: "composite", version: "1", used: 1, tags: [], variants: ["default"],
    composes: [], props: [], whenUse: [], whenNot: [], src: "", srcText: "", source,
  });
  const FIB_SRC = 'import { fibonacci } from "@bsc/algorithms/fibonacci";\nexport const C = () => fibonacci(10);';
  const FIB_NODE = libraryNodeId("algo", "fibonacci.ts");

  it("draws a project→algorithm `requires` edge for a kit the project consumes", () => {
    const refs = resolveKitLibraryRefs([comp("FibCard", FIB_SRC)]);
    const g = buildGlanceData(projects, [], [{ projectKey: "route-planner", kitId: "react-ui" }], kits, refs);

    const lib = g.rawNodes.filter((n) => n.kind === "library");
    expect(lib).toEqual([
      { id: FIB_NODE, slug: "fibonacci", kind: "library", library: "algo", role: "infra", health: "idle", activity: "idle" },
    ]);
    expect(g.rawEdges.filter((e) => e.kind === "requires")).toEqual([
      { id: requiresEdgeId("route-planner", FIB_NODE), from: "route-planner", to: FIB_NODE, kind: "requires" },
    ]);
    // the kit dimension is untouched — the project still consumes its kit
    expect(g.rawEdges.filter((e) => e.kind === "uses-kit")).toHaveLength(1);
  });

  it("fans one shared library node out to EVERY project consuming the kit", () => {
    const refs = resolveKitLibraryRefs([comp("FibCard", FIB_SRC)]);
    const g = buildGlanceData(projects, [], [
      { projectKey: "route-planner", kitId: "react-ui" },
      { projectKey: "app-b", kitId: "react-ui" },
    ], kits, refs);
    expect(g.rawNodes.filter((n) => n.kind === "library")).toHaveLength(1); // ONE band node, shared
    expect(g.rawEdges.filter((e) => e.kind === "requires").map((e) => e.from)).toEqual(["route-planner", "app-b"]);
  });

  it("carries an ALGORITHM and a SOUND as separately-tagged band nodes", () => {
    const refs = resolveKitLibraryRefs([
      comp("Mixed", 'import { fibonacci } from "@bsc/algorithms/fibonacci";\nimport { play } from "@bsc/sounds/click";\nexport const M = () => fibonacci(play());'),
    ]);
    const g = buildGlanceData(projects, [], [{ projectKey: "route-planner", kitId: "react-ui" }], kits, refs);
    expect(g.rawNodes.filter((n) => n.kind === "library").map((n) => n.library)).toEqual(["algo", "sound"]);
    expect(g.rawEdges.filter((e) => e.kind === "requires")).toHaveLength(2);
  });

  it("dedupes to ONE edge when a project consumes two kits requiring the same node", () => {
    const refs = resolveKitLibraryRefs([comp("A", FIB_SRC), comp("B", FIB_SRC, "other-kit")]);
    expect(refs).toHaveLength(2); // one ref per kit
    const g = buildGlanceData(projects, [], [
      { projectKey: "route-planner", kitId: "react-ui" },
      { projectKey: "route-planner", kitId: "other-kit" },
    ], [...kits, { id: "other-kit", name: "Other" }], refs);
    expect(g.rawNodes.filter((n) => n.kind === "library")).toHaveLength(1);
    expect(g.rawEdges.filter((e) => e.kind === "requires")).toHaveLength(1);
  });

  it("emits NOTHING for a library ref whose kit no project consumes (no dangling band node)", () => {
    const refs = resolveKitLibraryRefs([comp("FibCard", FIB_SRC)]);
    const g = buildGlanceData(projects, [], [], kits, refs);                                  // no usage at all
    expect(g.rawNodes.some((n) => n.kind === "library")).toBe(false);
    const stale = buildGlanceData(projects, [], [{ projectKey: "ghost", kitId: "react-ui" }], kits, refs);
    expect(stale.rawNodes.some((n) => n.kind === "library")).toBe(false); // consumer isn't in this graph
  });

  it("is byte-identical to the pre-#3133 graph when no component imports a library (no regression)", () => {
    const refs = resolveKitLibraryRefs([comp("Plain", "export const C = () => null;")]);
    expect(refs).toEqual([]);
    const usage = [{ projectKey: "route-planner", kitId: "react-ui" }];
    expect(buildGlanceData(projects, [], usage, kits, refs)).toEqual(buildGlanceData(projects, [], usage, kits));
  });
});
