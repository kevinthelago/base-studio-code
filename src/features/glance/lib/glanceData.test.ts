import { describe, it, expect } from "vitest";
import { SAMPLE_GRAPH, buildGlanceData } from "./glanceData";

// Guard for the externalized sample network (@data/glance/sample-graph.json, #2419).
describe("SAMPLE_GRAPH (loaded from @data/glance/sample-graph.json)", () => {
  it("is the 14-node / 20-edge Northwind spine, flagged sample", () => {
    expect(SAMPLE_GRAPH.sample).toBe(true);
    expect(SAMPLE_GRAPH.rawNodes).toHaveLength(14);
    expect(SAMPLE_GRAPH.rawEdges).toHaveLength(20);
  });

  it("is referentially intact — every edge endpoint is a node, every node id unique", () => {
    const ids = new Set(SAMPLE_GRAPH.rawNodes.map((n) => n.id));
    expect(ids.size).toBe(SAMPLE_GRAPH.rawNodes.length);
    for (const e of SAMPLE_GRAPH.rawEdges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
  });

  it("carries only valid role / health / activity / edge-kind tokens (#2541)", () => {
    const roles = ["infra", "service", "data", "client"];
    const healths = ["idle", "healthy", "warning", "error"];
    const activities = ["planning", "building", "waiting", "review", "live"];
    const kinds = ["api", "data", "events"];
    for (const n of SAMPLE_GRAPH.rawNodes) {
      expect(roles).toContain(n.role);
      expect(healths).toContain(n.health);
      expect(activities).toContain(n.activity);
    }
    for (const e of SAMPLE_GRAPH.rawEdges) expect(kinds).toContain(e.kind);
  });

  it("keeps the spec's reporting⇄analytics dependency cycle (the coordination-hazard example)", () => {
    const has = (from: string, to: string) => SAMPLE_GRAPH.rawEdges.some((e) => e.from === from && e.to === to);
    expect(has("reporting", "analytics")).toBe(true);
    expect(has("analytics", "reporting")).toBe(true);
  });
});

describe("buildGlanceData", () => {
  it("zero projects yields an EMPTY real graph — never the sample (#2272)", () => {
    const g = buildGlanceData([]);
    expect(g.sample).toBe(false);
    expect(g.rawNodes).toHaveLength(0);
    expect(g.rawEdges).toHaveLength(0);
  });
});
