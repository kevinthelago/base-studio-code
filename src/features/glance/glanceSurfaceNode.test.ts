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
