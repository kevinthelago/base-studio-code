// The COMMAND-SURFACE node kind (`command-surfaces-are-glance-nodes`, epic
// `epic-command-surfaces-are-nodes`) — the graph vocabulary for a `bsc` subcommand.
//
// Pins the parts a later consumer depends on and cannot re-derive: the id namespace, the band
// predicates, the meta lookup, and that the accent is actually distinct. Everything here is pure, so
// it holds whether the module is resolved from this file or from the `glance-graph.ts` record that
// shadows it on a machine whose store carries one.
import { describe, it, expect } from "vitest";
import {
  SURFACE_COLOR, SURFACE_META, SURFACE_NODE_PREFIX,
  surfaceNodeId, surfaceNameOfNode, invokesEdgeId,
  isBandNode, isBandEdge, bandNodeMeta,
  KIT_COLOR, ALGO_COLOR, SOUND_COLOR, MCP_COLOR, SERVICE_COLOR, ARCHITECT_COLOR,
  mcpNodeId, serviceNodeId, usesMcpEdgeId,
} from "@/features/glance/lib/glanceGraph";
import { buildGlanceData } from "@/features/glance/lib/glanceData";
import { withCommandSurfaces } from "@/features/glance/lib/glanceFleet";
import { roleCapability, roleDeniedCommands } from "@/shared/lib/session/sessionRoles";

describe("the command-surface node kind", () => {
  it("namespaces its id so it can never collide with a project key or another band node", () => {
    expect(surfaceNodeId("plan")).toBe("surface:plan");
    // A project key is a `[a-z0-9-]` slug with NO colon, so the prefix alone is the whole guarantee.
    expect(SURFACE_NODE_PREFIX).toContain(":");
    // `plan` is a plausible project name AND a real subcommand — exactly the collision the namespace
    // exists for, so assert it rather than trusting the prefix in the abstract.
    expect(surfaceNodeId("plan")).not.toBe("plan");
    // ...and distinct from every other band namespace for the same bare name.
    expect(new Set([surfaceNodeId("x"), mcpNodeId("x"), serviceNodeId("x")]).size).toBe(3);
  });

  it("round-trips the surface name, and leaves a bare name alone", () => {
    expect(surfaceNameOfNode(surfaceNodeId("graph"))).toBe("graph");
    expect(surfaceNameOfNode("graph")).toBe("graph"); // identity for anything already bare
  });

  it("gives the invokes edge its own id space", () => {
    expect(invokesEdgeId("session:designer", "ui")).toBe("invokes:session:designer>ui");
    // Never collides with the contract-edge ids, even for the same pair of bare names.
    expect(invokesEdgeId("a", "b")).not.toBe(usesMcpEdgeId("a", "b"));
  });

  it("is a fenced-band node with a band edge, so it lifts out of the project DAG", () => {
    expect(isBandNode({ kind: "surface" })).toBe(true);
    expect(isBandEdge("invokes")).toBe(true);
    // The project network is untouched: a project is still not a band node.
    expect(isBandNode({ kind: "project" })).toBe(false);
    expect(isBandEdge("api")).toBe(false);
  });

  it("resolves its own band presentation rather than falling through to the library default", () => {
    // The lookup is an if/else chain ending in LIBRARY_META, so an unhandled kind silently renders as
    // a UI KIT — a wrong-but-plausible result no snapshot would flag. Assert the row itself.
    expect(bandNodeMeta({ kind: "surface" })).toBe(SURFACE_META);
    expect(SURFACE_META.bandLabel).toBe("COMMAND SURFACES");
    expect(SURFACE_META.edgeLabel).toBe("invokes");
  });

  it("uses an accent no other band dimension already occupies", () => {
    // The band palette was ALREADY crowded — cyan/violet/pink/amber/indigo/bronze — so a new
    // dimension picked by eye can easily duplicate one and read as that dimension. Cheap to assert,
    // and the assertion is the reason the choice was lime rather than another teal.
    const taken = [KIT_COLOR, ALGO_COLOR, SOUND_COLOR, MCP_COLOR, SERVICE_COLOR, ARCHITECT_COLOR];
    expect(taken).not.toContain(SURFACE_COLOR);
    expect(new Set([...taken, SURFACE_COLOR]).size).toBe(taken.length + 1);
  });
});

// ── EMISSION ──────────────────────────────────────────────────────────────────────────────────────
// The vocabulary above is inert until something builds nodes with it. The band is emitted in the
// PROJECT DRILL (`withCommandSurfaces`), not at L0 — see `a-persona-declares-its-command-surfaces`.
describe("buildGlanceData — L0 no longer draws the surface band", () => {
  const p = [{ id: "app-a", name: "App A" }];

  it("emits no surface node and no invokes edge", () => {
    // It used to emit one node per catalog row and — as its own comment conceded — no edge, because
    // the `invokes` edge runs session→surface and L0 has no session node. That left 33 permanently
    // unconnected nodes beside the project network: an inventory of the CLI drawn as if it were part
    // of the project graph.
    const d = buildGlanceData(p, [], [], [], [], [], []);
    expect(d.rawNodes.filter((n) => n.kind === "surface")).toEqual([]);
    expect(d.rawEdges.filter((e) => e.kind === "invokes")).toEqual([]);
  });

  it("no longer TAKES a catalog at all", () => {
    // The parameter is gone rather than kept and ignored. A positional argument every caller still
    // passes and nothing reads is exactly how a future reader concludes L0 still draws these — so the
    // arity is the assertion.
    expect(buildGlanceData).toHaveLength(1); // only `projects` is required; the rest are defaulted
    const src = buildGlanceData.toString();
    expect(src).not.toMatch(/surfaceNodeId/);
  });
});

describe("withCommandSurfaces — the band in the project drill", () => {
  /** A drilled fleet: a director and a worker, as `buildOrgFleetData` shapes them. */
  const drill = () => ({
    sample: false,
    rawNodes: [
      { id: "director", slug: "director", role: "infra" as const, roleLabel: "director", health: "off" as const, activity: "idle" as const },
      { id: "api", slug: "api", role: "service" as const, roleLabel: "worker", health: "off" as const, activity: "idle" as const },
    ],
    rawEdges: [],
  });
  const CATALOG = [
    { name: "plan", status: "active" }, { name: "graph", status: "active" }, { name: "ui", status: "active" },
    { name: "files", status: "active" }, { name: "errors", status: "active" }, { name: "fleet", status: "active" },
    { name: "publish", status: "active" }, { name: "teams", status: "active" }, { name: "persona", status: "active" },
    { name: "logs", status: "active" }, { name: "request", status: "active" }, { name: "atlas", status: "active" },
  ];

  it("draws one node per surface the drill's agents DECLARE, and no others", () => {
    const d = withCommandSurfaces(drill(), CATALOG);
    const drawn = d.rawNodes.filter((n) => n.kind === "surface").map((n) => n.slug).sort();
    // The union of the worker's five and the director's eight.
    expect(drawn).toEqual(["errors", "files", "fleet", "graph", "logs", "persona", "plan", "publish", "request", "teams", "ui"]);
    // `atlas` is in the catalog and declared by nobody here, so the project's band does not carry it.
    expect(drawn).not.toContain("atlas");
  });

  it("edges each agent to its OWN surfaces — the band is per node, not per graph", () => {
    const d = withCommandSurfaces(drill(), CATALOG);
    const from = (id: string) => d.rawEdges.filter((e) => e.kind === "invokes" && e.from === id).map((e) => surfaceNameOfNode(e.to)).sort();
    expect(from("api")).toEqual(["errors", "files", "graph", "plan", "ui"]);
    expect(from("director")).toEqual(["errors", "fleet", "logs", "persona", "plan", "publish", "request", "teams"]);
  });

  it("points the edge session→surface, the consumer→provider direction every band uses", () => {
    const d = withCommandSurfaces(drill(), CATALOG);
    const e = d.rawEdges.find((x) => x.id === invokesEdgeId("api", "plan"))!;
    expect(e).toBeDefined();
    expect([e.from, e.to]).toEqual(["api", surfaceNodeId("plan")]);
  });

  it("SHARES one node between two agents that both declare a surface", () => {
    // The director and the worker both drive `plan`; two nodes would say they are different things.
    const d = withCommandSurfaces(drill(), CATALOG);
    expect(d.rawNodes.filter((n) => n.id === surfaceNodeId("plan"))).toHaveLength(1);
    expect(d.rawEdges.filter((e) => e.to === surfaceNodeId("plan"))).toHaveLength(2);
  });

  it("SKIPS a deprecated alias, so one store is never drawn as two surfaces", () => {
    // `bsc org` serves the same store as `bsc teams`; drawing both overstates the surface area.
    const d = withCommandSurfaces(drill(), [...CATALOG, { name: "org", status: "deprecated" }]);
    expect(d.rawNodes.filter((n) => n.kind === "surface").map((n) => n.slug)).not.toContain("org");
  });

  it("treats a catalog row with no status as active, since the catalog omits it for the common case", () => {
    const d = withCommandSurfaces(drill(), [{ name: "plan" }]);
    expect(d.rawNodes.filter((n) => n.kind === "surface").map((n) => n.slug)).toEqual(["plan"]);
  });

  it("draws NOTHING for an undeclared role rather than every surface", () => {
    // An undeclared role genuinely reaches the whole CLI, but 33 edges from it would bury the roles
    // that ARE constrained. An edgeless agent node is the visible TODO.
    const undeclared = { ...drill(), rawNodes: [{ id: "t", slug: "t", role: "client" as const, roleLabel: "triage", health: "off" as const, activity: "idle" as const }] };
    const d = withCommandSurfaces(undeclared, CATALOG);
    expect(d.rawNodes.filter((n) => n.kind === "surface")).toEqual([]);
    expect(d.rawEdges).toEqual([]);
  });

  it("is a no-op on an empty catalog, so a drill is byte-identical until both halves are present", () => {
    expect(withCommandSurfaces(drill(), [])).toEqual(drill());
    expect(withCommandSurfaces(drill())).toEqual(drill());
  });

  it("is IDEMPOTENT — re-running never doubles a node", () => {
    const once = withCommandSurfaces(drill(), CATALOG);
    const twice = withCommandSurfaces(once, CATALOG);
    expect(twice.rawNodes.filter((n) => n.kind === "surface")).toHaveLength(
      once.rawNodes.filter((n) => n.kind === "surface").length,
    );
  });

  it("never draws a surface the permission gate would deny — one source, two consumers", () => {
    // The band reads `personaSurfaces`, which is what `roleDeniedCommands` complements into the deny
    // list. If these could disagree, the graph would advertise a reach the session does not have.
    const d = withCommandSurfaces(drill(), CATALOG);
    const denied = new Set(roleDeniedCommands(roleCapability("worker"), CATALOG.map((c) => c.name)));
    for (const e of d.rawEdges.filter((x) => x.from === "api")) {
      expect(denied.has(`bsc ${surfaceNameOfNode(e.to)}`)).toBe(false);
    }
  });
});
