// #glance-reads-left-to-right-sessions-to-libraries — the app-owned system sessions on the L0 graph.
//
// The whole point of this dimension is POSITION: the graph should read as one pipeline in one direction —
// system sessions → architect → projects → libraries. Glance is a depends-on DAG where a dependency sits
// at a LOWER layer (further left), so the ordering is produced entirely by edge direction: the architect
// is `from` and the session is `to`. Asserting the resulting x-order is therefore asserting the feature,
// not the layout engine — get the direction backwards and the sessions land on the far RIGHT, past the
// libraries, with every test that only checks "the node exists" still green.
import { describe, it, expect } from "vitest";
import { buildGlanceData } from "./lib/glanceData";
import {
  buildGraph, isBandNode, bandNodeMeta, sessionNodeId, sessionIdOfNode, servedByEdgeId, architectNodeId,
  kitNodeId, SESSION_META,
} from "./lib/glanceGraph";

const projects = [
  { id: "app-a", name: "App A" },
  { id: "app-b", name: "App B" },
];
const architect = [{ id: "persona-architect", name: "Team architect" }];
const build = (p = projects, a = architect) => buildGlanceData(p, [], [], [], [], [], a);

describe("the system-session nodes", () => {
  it("emits the app-owned studios, namespaced, EXCLUDING the architect itself", () => {
    const d = build();
    const sessions = d.rawNodes.filter((n) => n.kind === "session");
    expect(sessions.map((n) => sessionIdOfNode(n.id)).sort()).toEqual([
      "designer", "integrator", "librarian", "sound-designer",
    ]);
    // The architect IS in the shared system-session list, but it already has its own L0 node — emitting
    // it here too would draw a session that serves itself.
    expect(sessions.some((n) => sessionIdOfNode(n.id) === "architect")).toBe(false);
    // A project key is a `[a-z0-9-]` slug with no colon, so the prefix is what makes this collision-proof.
    for (const n of sessions) expect(n.id).toContain(":");
    expect(sessionNodeId("designer")).toBe("session:designer");
  });

  it("wires every session to the architect, architect→session, so it lays out UPSTREAM of it", () => {
    const d = build();
    const served = d.rawEdges.filter((e) => e.kind === "served-by");
    expect(served).toHaveLength(4);
    for (const e of served) {
      // Direction is the whole feature: `from depends on to`, and a dependency sits at a LOWER layer.
      expect(e.from).toBe(architectNodeId("persona-architect"));
      expect(e.to.startsWith("session:")).toBe(true);
    }
    expect(served[0].id).toBe(servedByEdgeId("persona-architect", "designer"));
  });

  it("places every session LEFT of the architect, which stays left of every project", () => {
    const d = build();
    const m = buildGraph(d.rawNodes, d.rawEdges);
    const arch = m.nodes.find((n) => n.id === architectNodeId("persona-architect"))!;
    const sessions = m.nodes.filter((n) => n.kind === "session");
    const projs = m.nodes.filter((n) => !n.kind);

    expect(sessions).toHaveLength(4);
    for (const s of sessions) expect(s.x).toBeLessThan(arch.x);
    for (const p of projs) expect(p.x).toBeGreaterThan(arch.x);
  });

  it("reads left→right end to end: sessions → architect → projects → libraries", () => {
    // The full axis in one assertion. This is the arrangement the maintainer asked for, and it is the
    // thing that silently regresses if any one dimension's edge direction is flipped later.
    const d = buildGlanceData(
      projects, [], [{ projectKey: "app-a", kitId: "react-ui" }], [{ id: "react-ui", name: "React UI" }], [], [], architect,
    );
    const m = buildGraph(d.rawNodes, d.rawEdges);
    const x = (id: string) => m.nodes.find((n) => n.id === id)!.x;

    expect(x(sessionNodeId("designer"))).toBeLessThan(x(architectNodeId("persona-architect")));
    expect(x(architectNodeId("persona-architect"))).toBeLessThan(x("app-a"));
    expect(x("app-a")).toBeLessThan(x(kitNodeId("react-ui")));
    // …and the library really is in the fenced zone, not merely further right by accident.
    expect(x(kitNodeId("react-ui"))).toBeGreaterThanOrEqual(m.bandZone!.x0);
  });

  it("is NOT a band node — it lays out WITH the network, which is what gives it a layer", () => {
    // A band node is LIFTED out of the DAG and positioned by the band helper, so it has no layer to be
    // left of anything. Lifting a session would put it in the right-hand library column — the opposite
    // end of the graph from where it belongs.
    const d = build();
    const m = buildGraph(d.rawNodes, d.rawEdges);
    const session = m.nodes.find((n) => n.kind === "session")!;
    expect(isBandNode(session)).toBe(false);
    expect(session.layer).not.toBe(-1);
    // Its presentation row still exists, so a surface that wants the label/colour has one.
    expect(bandNodeMeta(session)).toBe(SESSION_META);
    expect(SESSION_META.kindLabel).toBe("session");
  });

  it("emits NOTHING when there is no architect — an unattached row of cards says less than nothing", () => {
    const d = buildGlanceData(projects, [], [], [], [], [], []);
    expect(d.rawNodes.some((n) => n.kind === "session")).toBe(false);
    expect(d.rawEdges.some((e) => e.kind === "served-by")).toBe(false);
  });

  it("keeps the architect a SINK for provenance while still depending on its sessions", () => {
    // `created-by` points AT the architect and `served-by` points AWAY from it. Both must hold: the first
    // is what stops a project↔architect cycle blanking the graph (glance-planner-edge-isolation), the
    // second is what puts the sessions upstream. A cycle here would take the whole board down.
    const d = build();
    const m = buildGraph(d.rawNodes, d.rawEdges);
    const archId = architectNodeId("persona-architect");
    for (const e of m.edges.filter((x) => x.kind === "created-by")) expect(e.to).toBe(archId);
    for (const e of m.edges.filter((x) => x.kind === "served-by")) expect(e.from).toBe(archId);
    expect(m.cycleNodeIds.size).toBe(0);
  });
});
