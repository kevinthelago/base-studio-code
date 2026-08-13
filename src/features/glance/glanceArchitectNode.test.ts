// #glance-architect-band + #architect-sits-with-the-projects + #architects-own-projects — the funnel's
// tier 1 on the L0 graph.
//
// The architect renders as a node IN the project network, edged to the projects it OWNS — not lifted
// into the fenced band the library and external-contract dimensions use. That band is for shared
// DEPENDENCIES a project consumes; an architect OWNS its projects, which is the opposite relationship,
// so it sits with them.
//
// #architects-own-projects narrowed the edge set: it used to be every architect to EVERY project (the
// first cut, because no ownership field existed), and the edge was called `created-by`. It is now
// `owned-by`, because an edge that can be REASSIGNED cannot claim to record who created the thing.
//
// The property that makes the placement safe is pinned below: the architect is a SINK (every `owned-by`
// edge points AT it), so it cannot close a cycle. Cycle regressions here have blanked the whole graph
// before (glance-planner-edge-isolation), so it is asserted rather than assumed.
import { describe, it, expect } from "vitest";
import { buildGlanceData, type ArchitectLite, type ProjectLite } from "./lib/glanceData";
import {
  buildGraph, isBandNode, isBandEdge, bandNodeMeta, architectNodeId, architectIdOfNode, ownedByEdgeId,
} from "./lib/glanceGraph";

const projects: ProjectLite[] = [
  { id: "app-a", name: "App A" },
  { id: "app-b", name: "App B" },
];
const architect: ArchitectLite[] = [{ id: "persona-architect", name: "Team architect" }];
const build = (p: ProjectLite[] = projects, a: ArchitectLite[] = architect) =>
  buildGlanceData(p, [], [], [], [], [], a);

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
    // relationship: an architect OWNS these projects rather than being consumed by them. Its
    // presentation row is kept, so a surface that wants the label/colour still has one.
    const d = build();
    const node = d.rawNodes.find((n) => n.id === architectNodeId("persona-architect"))!;
    expect(isBandNode(node)).toBe(false);
    expect(bandNodeMeta(node).bandLabel).toBe("ARCHITECTS");
  });

  it("adopts every UNASSIGNED project when it is the only architect, project as `from`", () => {
    // The sole-architect rule (#architects-own-projects): with one architect there is no choice to
    // make, so unassigned projects belong to it — which is what keeps a single-architect install
    // looking exactly as it did before ownership existed.
    const d = build();
    const edges = d.rawEdges.filter((e) => e.kind === "owned-by");
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.from).sort()).toEqual(["app-a", "app-b"]);
    for (const e of edges) expect(e.to).toBe(architectNodeId("persona-architect"));
    expect(edges[0].id).toBe(ownedByEdgeId("app-a", "persona-architect"));
  });

  it("its edge is NOT a band edge — it routes in the project network like any other", () => {
    expect(isBandEdge("owned-by")).toBe(false);
  });
});

describe("the degenerate cases render rather than break", () => {
  it("no architect persona ⇒ no node and no edge (the graph is exactly as it was)", () => {
    const d = buildGlanceData(projects, [], [], [], [], [], []);
    expect(d.rawNodes.some((n) => n.kind === "architect")).toBe(false);
    expect(d.rawEdges.some((e) => e.kind === "owned-by")).toBe(false);
  });

  it("an architect with NO projects still renders — an orphan band node, not a crash", () => {
    const d = build([], architect);
    expect(d.rawNodes.filter((n) => n.kind === "architect")).toHaveLength(1);
    expect(d.rawEdges.filter((e) => e.kind === "owned-by")).toHaveLength(0);
    expect(() => buildGraph(d.rawNodes, d.rawEdges)).not.toThrow();
  });

  it("TWO architects each draw ONLY the projects assigned to them, ids staying distinct", () => {
    // Multiple architects are a first-class case (funnel-architect-front-door), so this must not
    // assume a singleton — and the band must not collapse them onto one node. This is the case
    // #architects-own-projects exists for: the old first cut drew 4 edges here (every architect to
    // every project), which said nothing about who owns what.
    const two: ArchitectLite[] = [{ id: "persona-architect", name: "A1" }, { id: "persona-architect-2", name: "A2" }];
    const owned: ProjectLite[] = [
      { id: "app-a", name: "App A", architect: "persona-architect" },
      { id: "app-b", name: "App B", architect: "persona-architect-2" },
    ];
    const d = build(owned, two);
    expect(d.rawNodes.filter((n) => n.kind === "architect")).toHaveLength(2);
    const edges = d.rawEdges.filter((e) => e.kind === "owned-by");
    expect(edges).toHaveLength(2);
    expect(edges.find((e) => e.from === "app-a")!.to).toBe(architectNodeId("persona-architect"));
    expect(edges.find((e) => e.from === "app-b")!.to).toBe(architectNodeId("persona-architect-2"));
  });

  it("leaves an UNASSIGNED project with no architect once there are several to choose from", () => {
    // The honest answer is none: adopting it under some architect would put a project under one that
    // never claimed it. The missing edge is the graph asking which.
    const two: ArchitectLite[] = [{ id: "persona-architect", name: "A1" }, { id: "persona-architect-2", name: "A2" }];
    const d = build([{ id: "app-a", name: "App A" }], two);
    expect(d.rawEdges.filter((e) => e.kind === "owned-by")).toHaveLength(0);
    expect(d.rawNodes.filter((n) => n.kind === "architect"), "both still render").toHaveLength(2);
  });

  it("treats an assignment to a VANISHED architect as unassigned, not as an edge to nothing", () => {
    // A persona can be deleted or re-roled out from under an assignment. A stale id is a MISSING
    // owner, so it falls through to the unassigned rules — here, the sole architect adopts it.
    const d = build([{ id: "app-a", name: "App A", architect: "persona-deleted" }], architect);
    const edges = d.rawEdges.filter((e) => e.kind === "owned-by");
    expect(edges).toHaveLength(1);
    expect(edges[0].to).toBe(architectNodeId("persona-architect"));
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
    expect(d.rawEdges.every((e) => e.kind !== "owned-by" || e.to === architectNodeId("persona-architect"))).toBe(true);
  });

  it("does not disturb the band for the dimensions that DO belong in it", () => {
    // Removing the architect must leave the kit/library/contract lift exactly as it was.
    const withKit = buildGlanceData(projects, [], [{ projectKey: "app-a", kitId: "react-ui" }], [{ id: "react-ui", name: "React UI" }], [], [], architect);
    const m = buildGraph(withKit.rawNodes, withKit.rawEdges);
    expect(m.bandZone, "the kit band still forms").toBeTruthy();
    const arch = m.nodes.find((n) => n.id === architectNodeId("persona-architect"))!;
    const kit = m.nodes.find((n) => n.kind === "kit")!;
    expect(isBandNode(kit)).toBe(true);
    expect(isBandNode(arch)).toBe(false);
  });
});
