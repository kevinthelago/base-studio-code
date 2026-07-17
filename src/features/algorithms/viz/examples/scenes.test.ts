import { describe, it, expect } from "vitest";
import { TracedScene, TracedStack, runScene, type GraphInput } from "../../lib/tracer";
import { isPanelsFrame, type PanelsFrame, type ArrayFrame, type GraphFrame, type StackFrame } from "../../lib/trace";
import { dijkstraScene, bfsScene } from "./scenes";
import { WEIGHTED_GRAPH, DEFAULT_GRAPH } from "./graphAlgos";
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

describe("TracedStack — LIFO / FIFO / deque (#3266)", () => {
  it("a QUEUE pops the FRONT; a STACK pops the TOP", () => {
    const q = new TracedStack("queue");
    q.push(1); q.push(2); q.push(3);
    expect(q.pop()).toBe(1); // FIFO — front out first
    expect(q.size).toBe(2);

    const s = new TracedStack("stack");
    s.push(1); s.push(2);
    expect(s.pop()).toBe(2); // LIFO — top out first
  });

  it("records a frame per op — the data + the op verb + the mode", () => {
    const q = new TracedStack("queue");
    q.push(7);
    const frames = q.trace();
    expect(frames[0].data).toEqual([]); // at rest
    const last = frames[frames.length - 1];
    expect(last.data).toEqual([7]);
    expect(last.ops?.[0].op).toBe("push");
    expect(last.mode).toBe("queue");
  });
});

describe("bfsScene — the canonical multi-structure BFS (#3266)", () => {
  const frames = [...runScene(bfsScene, DEFAULT_GRAPH as GraphInput)()];

  it("runs as a graph + FIFO-queue scene, in sync", () => {
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every(isPanelsFrame)).toBe(true);
    expect(Object.keys((frames[0] as PanelsFrame).panels).sort()).toEqual(["graph", "queue"]);
  });

  it("the frontier queue enqueues then fully DRAINS while the graph is explored breadth-first", () => {
    const last = (frames[frames.length - 1] as PanelsFrame).panels;
    expect((last.queue as StackFrame).data).toEqual([]); // BFS drains the queue
    expect((last.queue as StackFrame).mode).toBe("queue");
    // Every node ends visited, the first one is the start.
    const graphMarks = (last.graph as GraphFrame).marks ?? {};
    expect(graphMarks.a).toBe("start");
    expect(Object.values(graphMarks).filter((m) => m === "visited").length).toBe(DEFAULT_GRAPH.nodes.length);
    // The queue actually moved — some frame shows a push and some a pop.
    const queueOps = frames.flatMap((f) => ((f as PanelsFrame).panels.queue as StackFrame | undefined)?.ops ?? []).map((o) => o.op);
    expect(queueOps).toContain("push");
    expect(queueOps).toContain("pop");
  });
});

describe("registry — bfs is now a SCENE with a queue panel (#3266)", () => {
  it("resolves to a multi-structure example: graph + stack renderers, panel frames", () => {
    const viz = programVizForImpl({ id: "bfs.rs", name: "bfs" })!;
    expect(viz).toBeDefined();
    expect(viz.renderers.graph).toBeDefined();
    expect(viz.renderers.stack).toBeDefined(); // the scene adds the queue panel
    expect([...viz.factory()].every(isPanelsFrame)).toBe(true);
  });
});
