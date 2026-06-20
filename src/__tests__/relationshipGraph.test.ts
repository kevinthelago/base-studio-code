import { describe, it, expect } from "vitest";
import {
  buildRelationshipGraph, effectiveVia,
  type RelStream, type RelationshipArtifact, type AgentRelationship,
} from "../screens/planner/relationship/relationshipGraph";
import { parseFleetFile, normalizeTopology } from "../screens/planner/planSections";

const STREAMS: RelStream[] = [
  { id: "schema", role: "worker", repo: "core" },
  { id: "auth", role: "worker", repo: "api" },
  { id: "api", role: "worker", repo: "api" },
];
const ARTIFACTS: RelationshipArtifact[] = [
  { id: "user-schema", name: "user-schema", kind: "schema", producer: "schema", consumers: ["auth", "api"], status: "ready" },
];
const EDGES: AgentRelationship[] = [
  { id: "h1", from: "schema", to: "auth", kind: "handoff", artifact: "user-schema", hardness: "blocking", via: "direct" },
  { id: "h2", from: "schema", to: "api", kind: "handoff", artifact: "user-schema", hardness: "blocking", via: "director" },
  { id: "n1", from: "auth", to: "api", kind: "notify", hardness: "notify", via: "direct" },
];

describe("effectiveVia", () => {
  it("director/peer force the via; hybrid keeps the edge's", () => {
    expect(effectiveVia("director", "direct")).toBe("director");
    expect(effectiveVia("peer", "director")).toBe("direct");
    expect(effectiveVia("hybrid", "direct")).toBe("direct");
    expect(effectiveVia("hybrid", "director")).toBe("director");
  });
});

describe("buildRelationshipGraph", () => {
  it("layers streams by ordering edges (schema=0, consumers=1)", () => {
    const g = buildRelationshipGraph(STREAMS, ARTIFACTS, EDGES, "hybrid");
    expect(g.layerOf.schema).toBe(0);
    expect(g.layerOf.auth).toBe(1);
    expect(g.layerOf.api).toBe(1);
    expect(g.hasCycle).toBe(false);
  });

  it("resolves viaEff against the topology", () => {
    const peer = buildRelationshipGraph(STREAMS, ARTIFACTS, EDGES, "peer");
    expect(peer.edges.every((e) => e.viaEff === "direct")).toBe(true);
    const dir = buildRelationshipGraph(STREAMS, ARTIFACTS, EDGES, "director");
    expect(dir.edges.every((e) => e.viaEff === "director")).toBe(true);
    const hyb = buildRelationshipGraph(STREAMS, ARTIFACTS, EDGES, "hybrid");
    expect(hyb.edges.find((e) => e.id === "h2")!.viaEff).toBe("director");
    expect(hyb.edges.find((e) => e.id === "h1")!.viaEff).toBe("direct");
  });

  it("detects an ordering cycle and flags the back-edge", () => {
    const cyclic = EDGES.concat([{ id: "cyc", from: "api", to: "schema", kind: "blocking", hardness: "blocking", via: "direct" }]);
    const g = buildRelationshipGraph(STREAMS, ARTIFACTS, cyclic, "hybrid");
    expect(g.hasCycle).toBe(true);
    expect(g.cycleEdgeIds.has("cyc")).toBe(true);
    // layering still terminates (back-edge excluded)
    expect(Object.keys(g.layerOf).length).toBe(3);
  });

  it("ignores non-ordering edges (notify) for cycles + layering", () => {
    // a notify back-edge must NOT create a cycle
    const g = buildRelationshipGraph(STREAMS, ARTIFACTS,
      EDGES.concat([{ id: "nb", from: "api", to: "schema", kind: "notify", hardness: "notify", via: "direct" }]), "hybrid");
    expect(g.hasCycle).toBe(false);
  });
});

describe("parseFleetFile — topology / artifacts / edges", () => {
  it("parses the relationship fields and defaults the topology", () => {
    const fleet = parseFleetFile(JSON.stringify({
      recommended: 2, streams: [{ id: "schema", repo: "core" }, { id: "auth", repo: "api" }],
      topology: "peer",
      artifacts: [{ id: "user-schema", producer: "schema", consumers: ["auth"], kind: "schema", status: "ready" }],
      edges: [{ id: "h1", from: "schema", to: "auth", kind: "handoff", artifact: "user-schema", hardness: "blocking", via: "direct" }],
    }))!;
    expect(fleet.topology).toBe("peer");
    expect(fleet.artifacts).toHaveLength(1);
    expect(fleet.artifacts![0].consumers).toEqual(["auth"]);
    expect(fleet.edges![0].kind).toBe("handoff");
  });

  it("coerces a bad kind/hardness/via and drops nameless artifacts/edges", () => {
    const fleet = parseFleetFile(JSON.stringify({
      streams: [{ id: "a", repo: "r" }],
      artifacts: [{ producer: "a" }, { id: "x", producer: "a" }],   // first has no id → dropped
      edges: [{ from: "a" }, { id: "e", from: "a", to: "b", kind: "bogus", hardness: "nope", via: "weird" }],
    }))!;
    expect(fleet.artifacts).toHaveLength(1);
    expect(fleet.edges).toHaveLength(1);
    expect(fleet.edges![0].kind).toBe("blocking");   // coerced
    expect(fleet.edges![0].hardness).toBe("blocking");
    expect(fleet.edges![0].via).toBe("direct");
  });

  it("normalizeTopology defaults to hybrid", () => {
    expect(normalizeTopology("director")).toBe("director");
    expect(normalizeTopology("garbage")).toBe("hybrid");
    expect(normalizeTopology(undefined)).toBe("hybrid");
  });
});
