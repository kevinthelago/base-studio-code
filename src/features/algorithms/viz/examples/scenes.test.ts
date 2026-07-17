import { describe, it, expect } from "vitest";
import { TracedScene, runScene, type GraphInput } from "../../lib/tracer";
import { isPanelsFrame, type PanelsFrame, type ArrayFrame, type GraphFrame } from "../../lib/trace";
import { dijkstraScene } from "./scenes";
import { WEIGHTED_GRAPH } from "./graphAlgos";
import { programVizForImpl } from "./registry";

describe("TracedScene / runScene — synchronized multi-structure panels (#3259)", () => {
  const twoPanel = (scene: TracedScene) => {
    const nums = scene.array("nums", [3, 1, 2]);
    const g = scene.graph("g", { nodes: [{ id: "x" }, { id: "y" }], edges: [{ from: "x", to: "y" }] });
    nums.swap(0, 1); // an op on the array panel
    g.visit("x"); // an op on the graph panel
  };
  const frames = [...runScene(twoPanel, null)()]; // this scene ignores the seed input

  it("every frame is a PanelsFrame carrying ALL declared panels", () => {
    expect(frames.length).toBe(3); // beat 0 (rest) + swap + visit
    expect(frames.every(isPanelsFrame)).toBe(true);
    for (const f of frames) expect(Object.keys((f as PanelsFrame).panels).sort()).toEqual(["g", "nums"]);
  });

  it("beat 0 is every panel at rest", () => {
    const p0 = (frames[0] as PanelsFrame).panels;
    expect((p0.nums as ArrayFrame).data).toEqual([3, 1, 2]);
    expect((p0.nums as ArrayFrame).ops).toBeUndefined(); // no op yet
  });

  it("an op advances only the acting panel; the others hold their current state", () => {
    // frame 1 = the array swap; the graph is still at rest.
    const p1 = (frames[1] as PanelsFrame).panels;
    expect((p1.nums as ArrayFrame).data).toEqual([1, 3, 2]);
    expect((p1.nums as ArrayFrame).ops?.[0].op).toBe("swap");
    expect((p1.g as GraphFrame).ops).toBeUndefined();
    // frame 2 = the graph visit; the array holds its SWAPPED state.
    const p2 = (frames[2] as PanelsFrame).panels;
    expect((p2.g as GraphFrame).ops?.[0].op).toBe("visit");
    expect((p2.nums as ArrayFrame).data).toEqual([1, 3, 2]); // unchanged since its own last op
  });
});

describe("dijkstraScene — the canonical multi-structure algorithm (#3259)", () => {
  const frames = [...runScene(dijkstraScene, WEIGHTED_GRAPH as GraphInput)()];

  it("runs as a graph + distance-array scene, in sync", () => {
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every(isPanelsFrame)).toBe(true);
    expect(Object.keys((frames[0] as PanelsFrame).panels).sort()).toEqual(["distance", "graph"]);
  });

  it("the distance panel ends at the real shortest distances while the graph is fully explored", () => {
    const last = (frames[frames.length - 1] as PanelsFrame).panels;
    // Undirected Dijkstra over WEIGHTED_GRAPH: a=0 c=2 b=3 d=8 e=10 f=13 (node-verified).
    expect((last.distance as ArrayFrame).data).toEqual([0, 3, 2, 8, 10, 13]);
    // The graph co-star shows the exploration (start + visited marks).
    const graphMarks = (last.graph as GraphFrame).marks ?? {};
    expect(graphMarks.a).toBe("start");
    expect(Object.values(graphMarks).filter((m) => m === "visited").length).toBeGreaterThan(0);
  });
});

describe("registry — dijkstra is now a SCENE (#3259)", () => {
  it("resolves to a multi-structure example: graph + array renderers, panel frames", () => {
    const viz = programVizForImpl({ id: "dijkstra.rs", name: "dijkstra" })!;
    expect(viz).toBeDefined();
    expect(viz.renderers.graph).toBeDefined();
    expect(viz.renderers.array).toBeDefined(); // the scene adds the distance array (was graph-only pre-#3259)
    expect([...viz.factory()].every(isPanelsFrame)).toBe(true);
  });
});
