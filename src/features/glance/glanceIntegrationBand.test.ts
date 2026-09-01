// The INTEGRATION band vocabulary (`an-integration-is-a-glance-node-with-a-real-signal`).
//
// These pin the decisions that were live alternatives, each of which would have been wrong in a way
// nothing else would catch: reusing the `service` kind (already taken by a hand-declared endpoint),
// reusing `library` (a cross-graph algorithm or sound), and keying on a bare slug (`stripe` is a valid
// project key, so the namespace is the only thing keeping them apart).
import { describe, it, expect } from "vitest";
import {
  INTEGRATION_META,
  INTEGRATION_NODE_PREFIX,
  integrationNodeId,
  integrationIdOfNode,
  usesIntegrationEdgeId,
  bandNodeMeta,
  isBandNode,
  isBandEdge,
  EDGE_META,
  MCP_META,
  SERVICE_META,
  SURFACE_META,
  LIBRARY_META,
  type GNodeKind,
} from "@/features/glance/lib/glanceGraph";

describe("the integration band", () => {
  it("is its own kind, not a reuse of service, surface or library", () => {
    const kind: GNodeKind = "integration";
    expect(bandNodeMeta({ kind })).toBe(INTEGRATION_META);
    // `service` is the near-miss and the one that would have been chosen by default: a hand-declared
    // endpoint with a URL. An integration is backed by a probed, tried, registered manifest and can
    // report what it last verified, which a service node structurally cannot carry.
    expect(bandNodeMeta({ kind })).not.toBe(SERVICE_META);
    expect(bandNodeMeta({ kind })).not.toBe(MCP_META);
    expect(bandNodeMeta({ kind })).not.toBe(SURFACE_META);
    expect(bandNodeMeta({ kind })).not.toBe(LIBRARY_META.algo);
  });

  it("renders in the fenced band, and its edge routes there too", () => {
    expect(isBandNode({ kind: "integration" })).toBe(true);
    expect(isBandEdge("uses-integration")).toBe(true);
  });

  it("carries a full presentation row with an accent no neighbouring dimension uses", () => {
    for (const [field, value] of Object.entries(INTEGRATION_META)) {
      expect(typeof value, `${field} must be a string`).toBe("string");
      expect(value.length, `${field} must not be blank`).toBeGreaterThan(0);
    }
    const others = [MCP_META.color, SERVICE_META.color, SURFACE_META.color, ...Object.values(LIBRARY_META).map((m) => m.color)];
    expect(others).not.toContain(INTEGRATION_META.color);
  });

  it("namespaces its node id, because a bare integration slug IS a valid project key", () => {
    expect(integrationNodeId("stripe")).toBe("integration:stripe");
    expect(INTEGRATION_NODE_PREFIX).not.toBe("");
    expect(integrationIdOfNode(integrationNodeId("stripe"))).toBe("stripe");
    // An unprefixed id passes through unchanged rather than being mangled.
    expect(integrationIdOfNode("stripe")).toBe("stripe");
  });

  it("keys its edge on BOTH ends, since one integration is routinely declared by several projects", () => {
    expect(usesIntegrationEdgeId("storefront", "stripe")).not.toBe(usesIntegrationEdgeId("billing", "stripe"));
    expect(usesIntegrationEdgeId("storefront", "stripe")).toBe(usesIntegrationEdgeId("storefront", "stripe"));
  });

  it("has an EDGE_META row, or the edge renders as an unlabelled line", () => {
    // The whole-program check is what caught this being missed for `depends-on`; assert it here so a
    // test sees it too, since only tsc executes that map otherwise.
    expect(EDGE_META["uses-integration"]).toBeDefined();
    expect(EDGE_META["uses-integration"].color).toBe(INTEGRATION_META.color);
    expect(EDGE_META["uses-integration"].label.length).toBeGreaterThan(0);
  });
});
