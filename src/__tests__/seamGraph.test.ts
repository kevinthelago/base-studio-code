import { describe, it, expect } from "vitest";
import { buildSeamGraph } from "../screens/planner/shared/seamGraph";
import type { FeatureContract } from "../screens/planner/issues/featureContract";

const ref = (name: string) => ({ name, definedIn: "x.ts", signature: "type X" });
function fc(id: string, produces: string[], consumes: string[]): FeatureContract {
  return {
    id, title: id.toUpperCase(), goal: "g", acceptance: ["a"], owns: ["src/**"],
    consumes: consumes.map(ref), produces: produces.map(ref),
    verification: { tests: [], gate: [] }, dependsOn: [], blocks: [],
  };
}

describe("buildSeamGraph", () => {
  it("chains producer → consumer into a layered DAG", () => {
    const g = buildSeamGraph([
      fc("a", ["X"], []),
      fc("b", ["Y"], ["X"]),
      fc("c", [], ["Y"]),
    ]);
    expect(g.edges).toEqual([
      { from: "a", to: "b", contract: "X" },
      { from: "b", to: "c", contract: "Y" },
    ]);
    expect(g.layers).toEqual([["a"], ["b"], ["c"]]);
    expect(g.nodes.find((n) => n.id === "c")!.layer).toBe(2);
    expect(g.validation.ok).toBe(true);
  });

  it("fan-in: two producers into one consumer share a layer below it", () => {
    const g = buildSeamGraph([
      fc("a", ["X"], []),
      fc("b", ["Y"], []),
      fc("c", [], ["X", "Y"]),
    ]);
    expect(g.layers[0].sort()).toEqual(["a", "b"]);
    expect(g.layers[1]).toEqual(["c"]);
    expect(g.edges.map((e) => `${e.from}->${e.to}`).sort()).toEqual(["a->c", "b->c"]);
  });

  it("a consume with no producer is dangling, not an edge", () => {
    const g = buildSeamGraph([fc("d", [], ["Z"])]);
    expect(g.edges).toEqual([]);
    expect(g.validation.dangling.map((x) => `${x.featureId}:${x.ref.name}`)).toEqual(["d:Z"]);
    expect(g.nodes[0].layer).toBe(0);
  });

  it("ignores a self-consume (no self-edge)", () => {
    const g = buildSeamGraph([fc("a", ["X"], ["X"])]);
    expect(g.edges).toEqual([]);
  });

  it("flags a contract produced by two features (duplicate)", () => {
    const g = buildSeamGraph([fc("a", ["X"], []), fc("a2", ["X"], [])]);
    expect(g.validation.duplicateProduces.map((d) => d.name)).toEqual(["X"]);
    expect(g.validation.ok).toBe(false);
  });
});
