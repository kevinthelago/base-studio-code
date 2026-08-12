// #glance-architect-band + #architect-sits-with-the-projects — the funnel's tier 1 on the L0 graph.
//
// The architect renders as a node IN the project network, edged to every project — not lifted into the
// fenced band the library and external-contract dimensions use. That band is for shared DEPENDENCIES a
// project consumes; an architect is the thing that CREATED the projects, which is the opposite
// relationship, so it sits with them.
//
// The property that makes that safe is pinned below: the architect is a SINK (every `created-by` edge
// points AT it), so it cannot close a cycle. Cycle regressions here have blanked the whole graph before
// (glance-planner-edge-isolation), so it is asserted rather than assumed.
import { describe, it, expect } from "vitest";
import { buildGlanceData } from "./lib/glanceData";
import {
  buildGraph, isBandNode, isBandEdge, bandNodeMeta, architectNodeId, architectIdOfNode, createdByEdgeId,
} from "./lib/glanceGraph";

const projects = [
  { id: "app-a", name: "App A" },
  { id: "app-b", name: "App B" },
];
const architect = [{ id: "persona-architect", name: "Team architect" }];
const build = (p = projects, a = architect) => buildGlanceData(p, [], [], [], [], [], a);

describe("the architect node", () => {
  it("is emitted once per architect persona, namespaced so it cannot collide with a project key", () => {
    const d = build();
    const node = d.rawNodes.find((n) => n.id === architectNodeId("persona-architect"));
    expect(node).toBeTruthy();
    expect(node!.kind).toBe("architect");
    expect(node!.slug).toBe("Team architect");
    // A project key is a `[a-z0-9-]` slug with no colon, so the prefix is what makes this collision-proof.
    expect(node!.id).toContain(":");
    expect(architectIdOfNode(node!.id)).toBe("persona-architect");
  });

  it("is NOT a band node — it lays out WITH the projects (#architect-sits-with-the-projects)", () => {
    // The fenced band is for shared DEPENDENCIES (kits, algorithms, MCP servers), which is the wrong
    // relationship: an architect CREATED these projects rather than being consumed by them. Its
    // presentation row is kept, so a surface that wants the label/colour still has one.
    const d = build();
    const node = d.rawNodes.find((n) => n.id === architectNodeId("persona-architect"))!;
    expect(isBandNode(node)).toBe(false);
    expect(bandNodeMeta(node).bandLabel).toBe("ARCHITECTS");
  });

  it("connects to EVERY project, with the project as `from` (the consumer→provider convention)", () => {
    const d = build();
    const edges = d.rawEdges.filter((e) => e.kind === "created-by");
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.from).sort()).toEqual(["app-a", "app-b"]);
    for (const e of edges) expect(e.to).toBe(architectNodeId("persona-architect"));
    expect(edges[0].id).toBe(createdByEdgeId("app-a", "persona-architect"));
  });

  it("its edge is NOT a band edge — it routes in the project network like any other", () => {
    expect(isBandEdge("created-by")).toBe(false);
  });
});

describe("the degenerate cases render rather than break", () => {
  it("no architect persona ⇒ no node and no edge (the graph is exactly as it was)", () => {
    const d = buildGlanceData(projects, [], [], [], [], [], []);
    expect(d.rawNodes.some((n) => n.kind === "architect")).toBe(false);
    expect(d.rawEdges.some((e) => e.kind === "created-by")).toBe(false);
  });

  it("an architect with NO projects still renders — an orphan band node, not a crash", () => {
    const d = build([], architect);
    expect(d.rawNodes.filter((n) => n.kind === "architect")).toHaveLength(1);
    expect(d.rawEdges.filter((e) => e.kind === "created-by")).toHaveLength(0);
    expect(() => buildGraph(d.rawNodes, d.rawEdges)).not.toThrow();
  });

  it("TWO architects each connect to every project, and their ids stay distinct", () => {
    // Multiple architects are a first-class case (funnel-architect-front-door), so this must not
    // assume a singleton — and the band must not collapse them onto one node.
    const two = [{ id: "persona-architect", name: "A1" }, { id: "persona-architect-2", name: "A2" }];
    const d = build(projects, two);
    expect(d.rawNodes.filter((n) => n.kind === "architect")).toHaveLength(2);
    expect(d.rawEdges.filter((e) => e.kind === "created-by")).toHaveLength(4);
  });
});

describe("the band lift keeps the graph sound", () => {
  it("introduces no cycle — the architect is a SINK, and a cycle needs a path back out", () => {
    // The load-bearing safety property now that it is inside the project network. Cycle regressions
    // in this graph have blanked it before (glance-planner-edge-isolation), so this is asserted rather
    // than assumed.
    const d = build();
    const m = buildGraph(d.rawNodes, d.rawEdges);
    expect(m.cyclePairs).toHaveLength(0);
    expect(m.cycleNodeIds.size).toBe(0);
    expect(d.rawEdges.every((e) => e.kind !== "created-by" || e.to === architectNodeId("persona-architect"))).toBe(true);
  });

  it("does not disturb the band for the dimensions that DO belong in it", () => {
    // Removing the architect must leave the kit/library/contract lift exactly as it was.
    const withKit = buildGlanceData(projects, [], [{ projectKey: "app-a", kitId: "react-ui" }], [{ id: "react-ui", name: "React UI" }], [], [], architect);
    const m = buildGraph(withKit.rawNodes, withKit.rawEdges);
    expect(m.kitBand, "the kit band still forms").toBeTruthy();
    const arch = m.nodes.find((n) => n.id === architectNodeId("persona-architect"))!;
    const kit = m.nodes.find((n) => n.kind === "kit")!;
    expect(isBandNode(kit)).toBe(true);
    expect(isBandNode(arch)).toBe(false);
  });
});
