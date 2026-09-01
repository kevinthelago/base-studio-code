// The INTEGRATION node projection (`an-integration-is-a-glance-node-with-a-real-signal`) — the join of
// DEMAND (`bsc project integrations`) and SUPPLY (`bsc data connector status`).
//
// Every assertion here is about a decision that could plausibly have gone the other way, and would have
// been wrong in a way the UI would not reveal. The most important of them is that health is DERIVED:
// the surface band was reverted for shipping nodes whose dot could never change, and this projection is
// what stops that repeating.
import { describe, it, expect } from "vitest";
import {
  integrationGraph,
  integrationHealth,
  declaringProjectCount,
  type DeclaredIntegrationRow,
  type ConnectorStatusRow,
} from "@/features/glance/lib/integrationNodes";
import { integrationNodeId, usesIntegrationEdgeId, isBandNode, isBandEdge } from "@/features/glance/lib/glanceGraph";

const DECLARED: DeclaredIntegrationRow[] = [
  { project: "storefront", id: "stripe", name: "Stripe", direction: "runtime" },
  { project: "storefront", id: "salesforce", name: "Salesforce", direction: "source" },
  { project: "billing", id: "stripe", name: "Stripe", direction: "runtime" },
];

describe("the integration projection", () => {
  it("gives every DECLARED integration a node, even with no connector built yet", () => {
    const { nodes } = integrationGraph(DECLARED, []);
    expect(nodes.map((n) => n.id)).toEqual([integrationNodeId("stripe"), integrationNodeId("salesforce")]);
    // Declared-but-unbuilt is the Integrator's QUEUE rendered — wanted, not yet built. It must show,
    // and it must not claim health nobody measured.
    for (const n of nodes) expect(n.health).toBe("off");
  });

  it("also gives a node to a REGISTERED connector nobody declared", () => {
    // The maintainer's rule: if the integration exists, it is in the graph. A connector registered
    // app-wide is real and still needs an owner, so it appears — with no edges, not hidden.
    const { nodes, edges } = integrationGraph([], [{ id: "orphan", state: "live" }]);
    expect(nodes.map((n) => n.id)).toEqual([integrationNodeId("orphan")]);
    expect(edges).toEqual([]);
  });

  it("draws one edge per DECLARATION, so one integration wanted by two projects has two", () => {
    const { edges } = integrationGraph(DECLARED, []);
    expect(edges).toHaveLength(3);
    expect(edges.map((e) => e.id)).toContain(usesIntegrationEdgeId("storefront", "stripe"));
    expect(edges.map((e) => e.id)).toContain(usesIntegrationEdgeId("billing", "stripe"));
    // ...and only ONE node for that integration, which is what makes the shared dependency visible.
    const { nodes } = integrationGraph(DECLARED, []);
    expect(nodes.filter((n) => n.id === integrationNodeId("stripe"))).toHaveLength(1);
  });

  it("renders in the fenced band, node and edge alike", () => {
    const { nodes, edges } = integrationGraph(DECLARED, []);
    for (const n of nodes) expect(isBandNode(n), n.id).toBe(true);
    for (const e of edges) expect(isBandEdge(e.kind), e.kind).toBe(true);
  });

  // ── the half that makes this band renderable at all ───────────────────────────────────────────────

  it("DERIVES health from the verdict — every state reachable by real work", () => {
    const states: [ConnectorStatusRow["state"], string][] = [
      ["never-checked", "off"],
      ["live", "healthy"],
      ["stale", "warning"],
      ["failing", "error"],
    ];
    for (const [state, health] of states) {
      const { nodes } = integrationGraph([{ project: "p", id: "x" }], [{ id: "x", state }]);
      expect(nodes[0].health, `${state} must render ${health}`).toBe(health);
    }
  });

  it("says NO SIGNAL rather than healthy for anything nobody has verified", () => {
    // Both halves of "unmeasured": never built, and built but never checked.
    expect(integrationHealth(undefined)).toBe("off");
    expect(integrationHealth("never-checked")).toBe("off");
    // ...and never accidentally green.
    expect(integrationHealth(undefined)).not.toBe("healthy");
  });

  it("treats a STALE verdict as a warning, not an error — unverified is not broken", () => {
    // A manifest edited since the check says nothing about the current shape. Reporting `error` would
    // claim a failure nobody observed; reporting `healthy` would carry a green light onto code nobody
    // ran. `warning` is the only honest one.
    expect(integrationHealth("stale")).toBe("warning");
  });

  it("carries the failure reason ONLY when the dot actually changed", () => {
    const failing = integrationGraph([{ project: "p", id: "x" }], [{ id: "x", state: "failing", error: "404 on /invoices" }]);
    expect(failing.nodes[0].reason).toBe("404 on /invoices");
    // A reason beside a healthy dot reads as a problem that is not there.
    const live = integrationGraph([{ project: "p", id: "x" }], [{ id: "x", state: "live", error: "stale text" }]);
    expect(live.nodes[0].reason).toBeUndefined();
  });

  // ── the edges that must NOT be drawn ──────────────────────────────────────────────────────────────

  it("drops an edge to a project that is not in the graph", () => {
    // A dangling edge is worse than a missing one: the layout would carry an id nothing renders.
    const { edges } = integrationGraph(DECLARED, [], ["storefront"]);
    expect(edges.map((e) => e.from)).toEqual(["storefront", "storefront"]);
  });

  it("keeps every edge when the caller does not say which projects exist", () => {
    // `undefined` means "I do not know the project set" — filtering to nothing there would silently
    // empty the band for a caller that simply had not been given the list.
    expect(integrationGraph(DECLARED, []).edges).toHaveLength(3);
  });

  it("never draws the same edge twice, however often a project repeats a declaration", () => {
    const dupes = [...DECLARED, { project: "storefront", id: "stripe" }];
    expect(integrationGraph(dupes, []).edges).toHaveLength(3);
  });

  it("counts the projects a broken integration would reach", () => {
    expect(declaringProjectCount(DECLARED, "stripe")).toBe(2);
    expect(declaringProjectCount(DECLARED, "salesforce")).toBe(1);
    expect(declaringProjectCount(DECLARED, "nope")).toBe(0);
  });

  it("prefers the declared display name, falling back to the id", () => {
    const { nodes } = integrationGraph([{ project: "p", id: "stripe", name: "Stripe" }, { project: "p", id: "bare" }], []);
    expect(nodes.map((n) => n.slug)).toEqual(["Stripe", "bare"]);
  });
});
