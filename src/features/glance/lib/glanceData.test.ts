import { describe, it, expect } from "vitest";
import { SAMPLE_GRAPH, buildGlanceData } from "./glanceData";
import { kitNodeId, usesKitEdgeId, libraryNodeId, requiresEdgeId, mcpNodeId, usesMcpEdgeId, serviceNodeId, usesServiceEdgeId } from "./glanceGraph";
import type { ProjectLink } from "./projectLinks";
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

  it("builds a deterministic node — the same project id always yields the same node (#2583/#4052)", () => {
    // The lifecycle CATEGORY that used to be carried here is gone (#4052); what mattered about that
    // test — no hash-per-id tier, so a node never changes shape between renders — is asserted directly.
    const g = buildGlanceData([{ id: "p", name: "P" }]);
    expect(g.rawNodes[0]).toEqual(buildGlanceData([{ id: "p", name: "P" }]).rawNodes[0]);
    expect(g.rawNodes[0]).not.toHaveProperty("category");
  });

  it("carries a project's APP-TYPE onto the node — the contract endpoint-type discriminator (#3786/#3802)", () => {
    const g = buildGlanceData([{ id: "p", name: "P", appType: "api" }]);
    expect(g.rawNodes[0].appType).toBe("api");
    // absent appType ⇒ the node is byte-identical to before (toEqual ignores the undefined key)
    expect(buildGlanceData([{ id: "q", name: "Q" }]).rawNodes[0].appType).toBeUndefined();
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
    expect(kitNode).toMatchObject({ id: kitNodeId("react-ui"), kind: "kit", slug: "React UI", health: "off", activity: "idle" });
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
      { id: FIB_NODE, slug: "fibonacci", kind: "library", library: "algo", role: "infra", health: "off", activity: "idle" },
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

// The external MCP-CONTRACT dimension (#3786, Phase 1 inter-app contracts) — mirrors the kit loop: a
// SCOPED server (its `projects` names ≥1 project in the graph) becomes one contract node edged from each
// consumer; a GLOBAL server (`projects: []`, every session gets it) is skipped.
describe("buildGlanceData — MCP contract nodes (#3786)", () => {
  const projects = [{ id: "app-a", name: "App A" }, { id: "app-b", name: "App B" }];
  const server = (over: Partial<{ id: string; name: string; projects: string[]; transport: "stdio" | "http" }> = {}) =>
    ({ id: "postgres", name: "Postgres", projects: ["app-a"], transport: "stdio" as const, ...over });

  it("adds ONE mcp node per scoped server + one project→mcp `uses-mcp` edge per consumer", () => {
    const g = buildGlanceData(projects, [], [], [], [], [server({ projects: ["app-a", "app-b"] })]);
    const mcp = g.rawNodes.find((n) => n.kind === "mcp");
    expect(mcp).toMatchObject({ id: mcpNodeId("postgres"), kind: "mcp", slug: "Postgres", role: "infra", health: "off", activity: "idle" });
    expect(g.rawNodes.filter((n) => n.kind === "mcp")).toHaveLength(1); // two consumers of the SAME server ⇒ one node
    expect(g.rawEdges.filter((e) => e.kind === "uses-mcp")).toEqual([
      { id: usesMcpEdgeId("app-a", "postgres"), from: "app-a", to: mcpNodeId("postgres"), kind: "uses-mcp" },
      { id: usesMcpEdgeId("app-b", "postgres"), from: "app-b", to: mcpNodeId("postgres"), kind: "uses-mcp" },
    ]);
  });

  it("skips a GLOBAL server (empty `projects`) — a global built-in is not a specific contract", () => {
    const g = buildGlanceData(projects, [], [], [], [], [server({ projects: [] })]);
    expect(g.rawNodes.some((n) => n.kind === "mcp")).toBe(false);
    expect(g.rawEdges.some((e) => e.kind === "uses-mcp")).toBe(false);
  });

  it("emits NO mcp node for a server whose only scoped project isn't in this graph (stale scope)", () => {
    const g = buildGlanceData(projects, [], [], [], [], [server({ projects: ["ghost"] })]);
    expect(g.rawNodes.some((n) => n.kind === "mcp")).toBe(false);
    expect(g.rawEdges.some((e) => e.kind === "uses-mcp")).toBe(false);
  });

  it("derives the mcp node's appType from the transport — http ⇒ api, stdio ⇒ serverless", () => {
    const http = buildGlanceData(projects, [], [], [], [], [server({ id: "sentry", transport: "http" })]);
    expect(http.rawNodes.find((n) => n.kind === "mcp")?.appType).toBe("api");
    const stdio = buildGlanceData(projects, [], [], [], [], [server({ transport: "stdio" })]);
    expect(stdio.rawNodes.find((n) => n.kind === "mcp")?.appType).toBe("serverless");
  });

  it("dedupes a duplicate (projectKey, serverId) into a single edge", () => {
    const g = buildGlanceData(projects, [], [], [], [], [server({ projects: ["app-a", "app-a"] })]);
    expect(g.rawEdges.filter((e) => e.kind === "uses-mcp")).toHaveLength(1);
  });

  it("falls back to the server ID when it has no name", () => {
    const g = buildGlanceData(projects, [], [], [], [], [server({ id: "mystery", name: "", projects: ["app-a"] })]);
    expect(g.rawNodes.find((n) => n.kind === "mcp")?.slug).toBe("mystery");
  });

  it("adds nothing (byte-identical to before #3786) when there are no scoped mcp servers", () => {
    expect(buildGlanceData(projects, [], [], [], [], [])).toEqual(buildGlanceData(projects));
    expect(buildGlanceData(projects, [], [], [], [], [server({ projects: [] })])).toEqual(buildGlanceData(projects));
  });
});

// EXPLICIT, planner-declared inter-app contracts (#3786 Phase 2) — a stored ProjectLink whose `target` is
// a `service` or `mcp` endpoint (not another project) becomes an external band node edged from `from`,
// GENERALIZING the Phase-1 auto-derived mcp scope. Deduped against the auto-mcp nodes by node id.
describe("buildGlanceData — explicit external contracts (#3786 Phase 2)", () => {
  const projects = [{ id: "app-a", name: "App A" }, { id: "app-b", name: "App B" }];

  it("renders a SERVICE-targeted contract as ONE external service node + a uses-service edge", () => {
    const links: ProjectLink[] = [
      { id: "app-a>stripe:api", from: "app-a", to: "stripe", kind: "api",
        target: { type: "service", name: "Stripe", url: "https://api.stripe.com", appType: "api" } },
    ];
    const g = buildGlanceData(projects, links);
    expect(g.rawNodes.find((n) => n.kind === "service")).toMatchObject({
      id: serviceNodeId("stripe"), kind: "service", slug: "Stripe", appType: "api", role: "infra", health: "off", activity: "idle",
    });
    expect(g.rawEdges).toEqual([
      { id: usesServiceEdgeId("app-a", "stripe"), from: "app-a", to: serviceNodeId("stripe"), kind: "uses-service" },
    ]);
    // NOT a project edge (the target isn't a project) — lifted into the band, never the L0 network.
    expect(g.rawEdges.some((e) => e.id === "app-a>stripe:api")).toBe(false);
  });

  it("renders an MCP-targeted contract as ONE external mcp node + a uses-mcp edge, appType from the declaration", () => {
    const links: ProjectLink[] = [
      { id: "app-a>postgres:data", from: "app-a", to: "postgres", kind: "data", target: { type: "mcp", appType: "serverless" } },
    ];
    const g = buildGlanceData(projects, links);
    expect(g.rawNodes.find((n) => n.kind === "mcp")).toMatchObject({ id: mcpNodeId("postgres"), kind: "mcp", slug: "postgres", appType: "serverless" });
    expect(g.rawEdges).toEqual([
      { id: usesMcpEdgeId("app-a", "postgres"), from: "app-a", to: mcpNodeId("postgres"), kind: "uses-mcp" },
    ]);
  });

  it("DEDUPES an explicit mcp contract against a Phase-1 auto-derived mcp node — ONE node, ONE edge", () => {
    // `postgres` is BOTH in the mcp scope (Phase-1 auto) AND declared as an explicit contract from app-a:
    // the same server id ⇒ ONE node (the auto node wins) and the edge id collides ⇒ ONE edge.
    const links: ProjectLink[] = [
      { id: "app-a>postgres:data", from: "app-a", to: "postgres", kind: "data", target: { type: "mcp", appType: "serverless" } },
    ];
    const mcpServers = [{ id: "postgres", name: "Postgres", projects: ["app-a"], transport: "stdio" as const }];
    const g = buildGlanceData(projects, links, [], [], [], mcpServers);
    expect(g.rawNodes.filter((n) => n.kind === "mcp")).toHaveLength(1);
    expect(g.rawNodes.find((n) => n.kind === "mcp")?.slug).toBe("Postgres");  // the auto node (store name) wins
    expect(g.rawEdges.filter((e) => e.kind === "uses-mcp")).toHaveLength(1);
  });

  it("keeps an explicit contract ALONGSIDE a distinct auto-mcp node (no false dedup across kinds)", () => {
    const links: ProjectLink[] = [
      { id: "app-a>stripe:api", from: "app-a", to: "stripe", kind: "api", target: { type: "service", appType: "api" } },
    ];
    const mcpServers = [{ id: "postgres", name: "Postgres", projects: ["app-b"], transport: "http" as const }];
    const g = buildGlanceData(projects, links, [], [], [], mcpServers);
    expect(g.rawNodes.filter((n) => n.kind === "service")).toHaveLength(1);
    expect(g.rawNodes.filter((n) => n.kind === "mcp")).toHaveLength(1);
  });

  it("skips an external contract whose consuming project isn't in this graph (stale from)", () => {
    const links: ProjectLink[] = [
      { id: "ghost>stripe:api", from: "ghost", to: "stripe", kind: "api", target: { type: "service" } },
    ];
    const g = buildGlanceData(projects, links);
    expect(g.rawNodes.some((n) => n.kind === "service")).toBe(false);
    expect(g.rawEdges).toEqual([]);
  });

  it("leaves a legacy project↔project link (no target) as a plain L0 edge — byte-identical", () => {
    const link: ProjectLink = { id: "app-a>app-b:api", from: "app-a", to: "app-b", kind: "api" };
    const g = buildGlanceData(projects, [link]);
    expect(g.rawEdges).toEqual([{ id: "app-a>app-b:api", from: "app-a", to: "app-b", kind: "api" }]);
    expect(g.rawNodes.some((n) => n.kind === "service" || n.kind === "mcp")).toBe(false);
    // an explicit `{ type: "project" }` target draws the SAME plain project edge (no band node)
    const withProjTarget: ProjectLink = { ...link, target: { type: "project" } };
    expect(buildGlanceData(projects, [withProjTarget])).toEqual(g);
  });
});
