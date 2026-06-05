import { describe, it, expect } from "vitest";
import { buildSeamGraph, type SeamGraph } from "../lib/planSeamGraph";
import type { PlanIssue } from "../screens/projects/planIssues";

// ── helpers ───────────────────────────────────────────────────────────────────

function issue(ref: string, overrides: Partial<PlanIssue> = {}): PlanIssue {
  return {
    ref,
    title: `Issue ${ref}`,
    acceptance: [],
    owns: [],
    dependsOn: [],
    labels: [],
    ...overrides,
  };
}

function layersOf(g: SeamGraph): Map<string, number> {
  return new Map(g.nodes.map(n => [n.id, n.layer]));
}

// ── buildSeamGraph ────────────────────────────────────────────────────────────

describe("buildSeamGraph (#294 seam graph builder)", () => {

  it("returns an empty graph for an empty issue list", () => {
    const g = buildSeamGraph([]);
    expect(g.nodes).toHaveLength(0);
    expect(g.edges).toHaveLength(0);
    expect(g.layerCount).toBe(0);
    expect(g.danglingCount).toBe(0);
  });

  it("places a single node with no deps in layer 0", () => {
    const g = buildSeamGraph([issue("A")]);
    expect(g.nodes).toHaveLength(1);
    expect(g.nodes[0].layer).toBe(0);
    expect(g.nodes[0].order).toBe(0);
    expect(g.edges).toHaveLength(0);
  });

  it("builds a linear chain with increasing layers", () => {
    // A → B → C: A is layer 0, B is layer 1, C is layer 2.
    const issues = [
      issue("A"),
      issue("B", { dependsOn: ["A"] }),
      issue("C", { dependsOn: ["B"] }),
    ];
    const g = buildSeamGraph(issues);
    const layers = layersOf(g);
    expect(layers.get("A")).toBe(0);
    expect(layers.get("B")).toBe(1);
    expect(layers.get("C")).toBe(2);
    expect(g.layerCount).toBe(3);
    expect(g.danglingCount).toBe(0);
  });

  it("uses the longest path (critical path) for diamond DAGs", () => {
    // A → B, A → C, B → D, C → D.
    // Shortest path to D via A→B→D is 2; via A→C→D is also 2. Layer of D = 2.
    const issues = [
      issue("A"),
      issue("B", { dependsOn: ["A"] }),
      issue("C", { dependsOn: ["A"] }),
      issue("D", { dependsOn: ["B", "C"] }),
    ];
    const g = buildSeamGraph(issues);
    const layers = layersOf(g);
    expect(layers.get("A")).toBe(0);
    expect(layers.get("B")).toBe(1);
    expect(layers.get("C")).toBe(1);
    expect(layers.get("D")).toBe(2);
    expect(g.layerCount).toBe(3);
  });

  it("uses the longest path when branches have unequal depth", () => {
    // A → B → C → E, A → D → E.
    // Depth of E via A→B→C: 3; via A→D: 2. Longest path places E at layer 3.
    const issues = [
      issue("A"),
      issue("B", { dependsOn: ["A"] }),
      issue("C", { dependsOn: ["B"] }),
      issue("D", { dependsOn: ["A"] }),
      issue("E", { dependsOn: ["C", "D"] }),
    ];
    const g = buildSeamGraph(issues);
    const layers = layersOf(g);
    expect(layers.get("E")).toBe(3);
    expect(layers.get("D")).toBe(1);
  });

  it("marks dangling deps and counts them", () => {
    // B depends on X which is not in the issue list.
    const g = buildSeamGraph([issue("A"), issue("B", { dependsOn: ["X"] })]);
    expect(g.danglingCount).toBe(1);
    const dangling = g.edges.filter(e => e.dangling);
    expect(dangling).toHaveLength(1);
    expect(dangling[0].from).toBe("X");
    expect(dangling[0].to).toBe("B");
  });

  it("dangling deps do not affect layer assignment (B still lands at layer 0)", () => {
    // B has a dep on absent X; without incoming non-dangling edges B is a source.
    const g = buildSeamGraph([issue("A"), issue("B", { dependsOn: ["X"] })]);
    const layers = layersOf(g);
    expect(layers.get("B")).toBe(0);
  });

  it("multiple dangling deps accumulate in danglingCount", () => {
    const g = buildSeamGraph([issue("A", { dependsOn: ["X", "Y", "Z"] })]);
    expect(g.danglingCount).toBe(3);
  });

  it("filterRepo restricts nodes to the specified repo", () => {
    const issues = [
      issue("A", { repo: "org/web" }),
      issue("B", { repo: "org/api" }),
      issue("C", { repo: "org/web" }),
    ];
    const g = buildSeamGraph(issues, "org/web");
    expect(g.nodes.map(n => n.id).sort()).toEqual(["A", "C"]);
  });

  it("filterRepo marks cross-repo deps as dangling", () => {
    // C (web) depends on B (api); when filtered to web, dep on B is dangling.
    const issues = [
      issue("A", { repo: "org/web" }),
      issue("B", { repo: "org/api" }),
      issue("C", { repo: "org/web", dependsOn: ["B"] }),
    ];
    const g = buildSeamGraph(issues, "org/web");
    expect(g.danglingCount).toBe(1);
    expect(g.edges[0].dangling).toBe(true);
  });

  it("with no filterRepo, all issues are included and cross-repo deps resolve", () => {
    const issues = [
      issue("A", { repo: "org/web" }),
      issue("B", { repo: "org/api", dependsOn: ["A"] }),
    ];
    const g = buildSeamGraph(issues);
    expect(g.nodes).toHaveLength(2);
    expect(g.danglingCount).toBe(0);
    const layers = layersOf(g);
    expect(layers.get("A")).toBe(0);
    expect(layers.get("B")).toBe(1);
  });

  it("carries owns and acceptance onto each SeamNode for drill-down", () => {
    const accepts = ["criterion one", "criterion two"];
    const owns    = ["src/foo/**"];
    const g = buildSeamGraph([issue("A", { acceptance: accepts, owns })]);
    const n = g.nodes.find(n => n.id === "A")!;
    expect(n.owns).toEqual(owns);
    expect(n.acceptance).toEqual(accepts);
  });

  it("derives maturity: done when labels contain 'done'", () => {
    const g = buildSeamGraph([issue("A", { labels: ["done"] })]);
    expect(g.nodes[0].maturity).toBe("done");
  });

  it("derives maturity: done for 'closed' label", () => {
    const g = buildSeamGraph([issue("A", { labels: ["closed"] })]);
    expect(g.nodes[0].maturity).toBe("done");
  });

  it("derives maturity: active when ≥2 acceptance criteria AND has owns", () => {
    const g = buildSeamGraph([issue("A", { acceptance: ["a", "b"], owns: ["src/**"] })]);
    expect(g.nodes[0].maturity).toBe("active");
  });

  it("derives maturity: backlog when only acceptance criteria exist (no owns)", () => {
    const g = buildSeamGraph([issue("A", { acceptance: ["a"] })]);
    expect(g.nodes[0].maturity).toBe("backlog");
  });

  it("derives maturity: backlog when only owns exist (no acceptance)", () => {
    const g = buildSeamGraph([issue("A", { owns: ["src/**"] })]);
    expect(g.nodes[0].maturity).toBe("backlog");
  });

  it("derives maturity: stub when neither acceptance nor owns", () => {
    const g = buildSeamGraph([issue("A")]);
    expect(g.nodes[0].maturity).toBe("stub");
  });

  it("nodes within the same layer are ordered stably (by stream, then ref)", () => {
    const issues = [
      issue("C", { stream: "alpha" }),
      issue("A", { stream: "beta" }),
      issue("B", { stream: "alpha" }),
    ];
    const g = buildSeamGraph(issues);
    // All in layer 0. Sorted: alpha/B, alpha/C, beta/A → orders 0,1,2
    const orderByRef = new Map(g.nodes.map(n => [n.id, n.order]));
    expect(orderByRef.get("B")).toBeLessThan(orderByRef.get("C")!);
    expect(orderByRef.get("C")!).toBeLessThan(orderByRef.get("A")!);
  });

  it("carries stream and phase through to the node", () => {
    const g = buildSeamGraph([issue("A", { stream: "my-stream", phase: 2 })]);
    const n = g.nodes[0];
    expect(n.stream).toBe("my-stream");
    expect(n.phase).toBe(2);
  });

  it("disconnected subgraphs both land in their own layer assignments", () => {
    // Two independent chains: A→B and C→D.
    const issues = [
      issue("A"),
      issue("B", { dependsOn: ["A"] }),
      issue("C"),
      issue("D", { dependsOn: ["C"] }),
    ];
    const g = buildSeamGraph(issues);
    const layers = layersOf(g);
    expect(layers.get("A")).toBe(0);
    expect(layers.get("B")).toBe(1);
    expect(layers.get("C")).toBe(0);
    expect(layers.get("D")).toBe(1);
    expect(g.layerCount).toBe(2);
  });

  it("nodes in a cycle fall back to layer 0 (no infinite loop)", () => {
    // A → B → A (cycle). Kahn cannot process them, so both fall to layer 0.
    const issues = [
      issue("A", { dependsOn: ["B"] }),
      issue("B", { dependsOn: ["A"] }),
    ];
    // Must terminate without hanging.
    const g = buildSeamGraph(issues);
    expect(g.nodes).toHaveLength(2);
    const layers = layersOf(g);
    expect(layers.get("A")).toBe(0);
    expect(layers.get("B")).toBe(0);
  });
});
