// #glance-architect-band — the funnel's tier 1 on the L0 graph.
//
// The architect is lifted into the SAME fenced band as the library + external-contract dimensions
// (#3007 → #3119 → #3786) rather than getting a bespoke layout, and it is edged to every project. That
// band lift is what keeps it out of the project DAG — which is the property worth pinning, because a
// non-project node left in the DAG is exactly what closed the cycles `glance-planner-edge-isolation`
// had to unpick.
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

  it("is a BAND node, so the layout lifts it out of the project DAG", () => {
    const d = build();
    const node = d.rawNodes.find((n) => n.id === architectNodeId("persona-architect"))!;
    expect(isBandNode(node)).toBe(true);
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

  it("its edge is a BAND edge, so it routes vertically instead of joining the project network", () => {
    expect(isBandEdge("created-by")).toBe(true);
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
  it("introduces no cycle, and the architect is fenced above the projects", () => {
    const d = build();
    const m = buildGraph(d.rawNodes, d.rawEdges);
    expect(m.cyclePairs).toHaveLength(0);
    expect(m.cycleNodeIds.size).toBe(0);
    // The fenced band exists and the architect sits inside it, above every project node.
    expect(m.kitBand).toBeTruthy();
    const arch = m.nodes.find((n) => n.id === architectNodeId("persona-architect"))!;
    const projNodes = m.nodes.filter((n) => !isBandNode(n));
    for (const p of projNodes) expect(arch.y).toBeLessThan(p.y);
  });
});
