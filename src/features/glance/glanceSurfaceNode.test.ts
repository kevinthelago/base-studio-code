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
} from "./lib/glanceGraph";
import { buildGlanceData } from "./lib/glanceData";

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
// The vocabulary above is inert until something builds nodes with it. These pin the builder's actual
// behaviour, including the two decisions that are easy to mistake for bugs later: deprecated aliases
// are skipped, and no `invokes` edge is emitted at L0.
describe("buildGlanceData — command-surface nodes", () => {
  const p = [{ id: "app-a", name: "App A" }];

  it("emits one fenced-band node per active surface, generated from the catalog", () => {
    const d = buildGlanceData(p, [], [], [], [], [], [], [
      { name: "plan", status: "active", store: "plan.db" },
      { name: "ui", status: "active" },
    ]);
    const surfaces = d.rawNodes.filter((n) => n.kind === "surface");
    expect(surfaces.map((n) => n.id)).toEqual([surfaceNodeId("plan"), surfaceNodeId("ui")]);
    // A band node lifts out of the project DAG, which is what puts it in the fence rather than the graph.
    expect(surfaces.every((n) => isBandNode(n))).toBe(true);
    // The display name is the subcommand token an operator actually types.
    expect(surfaces.map((n) => n.slug)).toEqual(["plan", "ui"]);
  });

  it("SKIPS a deprecated alias, so one store is never drawn as two surfaces", () => {
    // `bsc org` is a deprecated alias for `bsc teams` over the same store. Drawing both would put two
    // nodes on one store and overstate the surface area — and the catalog already carries the status,
    // so this reads it instead of keeping a skip-list that would need its own maintenance.
    const d = buildGlanceData(p, [], [], [], [], [], [], [
      { name: "teams", status: "active" },
      { name: "org", status: "deprecated" },
    ]);
    expect(d.rawNodes.filter((n) => n.kind === "surface").map((n) => n.slug)).toEqual(["teams"]);
  });

  it("emits NO invokes edge at L0 — the session nodes it would leave from are not here", () => {
    // Not an omission: system-session nodes MOVED into the architect node's drill-in
    // (#architect-node-expands-into-system-sessions), so at L0 there is no session for a session→surface
    // edge to start from. Emitting one anyway would dangle, or invent a project→surface relationship the
    // epic explicitly rejected. This test is what stops someone "fixing" that later.
    const d = buildGlanceData(p, [], [], [], [], [], [], [{ name: "plan", status: "active" }]);
    expect(d.rawEdges.filter((e) => e.kind === "invokes")).toEqual([]);
  });

  it("is additive — no catalog means a byte-identical graph", () => {
    const without = buildGlanceData(p, [], [], [], [], [], []);
    const withEmpty = buildGlanceData(p, [], [], [], [], [], [], []);
    expect(withEmpty).toEqual(without);
  });

  it("treats a surface with no status as active, since the catalog omits it for the common case", () => {
    const d = buildGlanceData(p, [], [], [], [], [], [], [{ name: "cad" }]);
    expect(d.rawNodes.filter((n) => n.kind === "surface").map((n) => n.slug)).toEqual(["cad"]);
  });
});
