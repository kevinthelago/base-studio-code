// buildGlanceData emits the integration band (`the-integration-band-gets-its-data-path`).
//
// The projection itself is tested in glanceIntegrationNodes.test.ts; these are about the WIRING —
// that the band actually reaches the graph, that it contributes nothing when there is nothing, and
// that it is handed the project set so no dangling edge is drawn.
import { describe, it, expect } from "vitest";
import { buildGlanceData } from "@/features/glance/lib/glanceData";
import { integrationNodeId, usesIntegrationEdgeId, isBandNode } from "@/features/glance/lib/glanceGraph";

const projects = [{ id: "storefront", name: "Storefront" }, { id: "billing", name: "Billing" }];
const build = (declared = [] as never[], connectors = [] as never[]) =>
  buildGlanceData(projects, [], [], [], [], [], [], declared, connectors);

describe("buildGlanceData · the integration band", () => {
  /// THE STATE OF EVERY MACHINE TODAY: nothing declared, nothing registered. It must add no marks.
  it("contributes nothing when nothing is declared or registered", () => {
    const d = build();
    expect(d.rawNodes.filter((n) => n.kind === "integration")).toEqual([]);
    expect(d.rawEdges.filter((e) => e.kind === "uses-integration")).toEqual([]);
    // ...and the projects are untouched, so wiring this in changed no existing node.
    expect(d.rawNodes.map((n) => n.id)).toEqual(["storefront", "billing"]);
  });

  it("emits a band node and its project edge once something is declared", () => {
    const d = build(
      [{ project: "storefront", id: "stripe", name: "Stripe" }] as never[],
      [{ id: "stripe", state: "live" }] as never[],
    );
    const node = d.rawNodes.find((n) => n.id === integrationNodeId("stripe"));
    expect(node).toBeDefined();
    expect(node!.health).toBe("healthy");
    expect(isBandNode(node!)).toBe(true);
    expect(d.rawEdges.map((e) => e.id)).toContain(usesIntegrationEdgeId("storefront", "stripe"));
  });

  /// The project set is passed for a reason: a declaration from a project NOT in this graph would
  /// otherwise draw an edge to an id nothing renders.
  it("draws no edge from a project that is not in the graph", () => {
    const d = build(
      [{ project: "ghost", id: "stripe" }, { project: "billing", id: "stripe" }] as never[],
      [] as never[],
    );
    const froms = d.rawEdges.filter((e) => e.kind === "uses-integration").map((e) => e.from);
    expect(froms).toEqual(["billing"]);
    // The NODE still exists — the integration is real even though one declarer is not in view.
    expect(d.rawNodes.some((n) => n.id === integrationNodeId("stripe"))).toBe(true);
  });

  /// A registered connector nobody declared still gets a node, with no edges. The maintainer's rule:
  /// if the integration exists, it is in the graph.
  it("shows a registered connector nobody declared, unconnected", () => {
    const d = build([] as never[], [{ id: "orphan", state: "never-checked" }] as never[]);
    const node = d.rawNodes.find((n) => n.id === integrationNodeId("orphan"));
    expect(node).toBeDefined();
    expect(node!.health).toBe("off");
    expect(d.rawEdges.filter((e) => e.kind === "uses-integration")).toEqual([]);
  });

  /// The wiring must not change what an existing caller gets — every prior positional argument keeps
  /// its meaning and a caller that passes none of the new ones is unaffected.
  it("is backwards compatible with every existing call shape", () => {
    const before = buildGlanceData(projects, [], [], [], [], [], []);
    const after = build();
    expect(after.rawNodes).toEqual(before.rawNodes);
    expect(after.rawEdges).toEqual(before.rawEdges);
  });
});
