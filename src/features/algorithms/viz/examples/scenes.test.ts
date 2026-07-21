import { describe, it, expect } from "vitest";
import { TracedScene, TracedStack, TracedScalar, TracedTree, runScene, type GraphInput } from "../../lib/tracer";
import { isPanelsFrame, type PanelsFrame, type ArrayFrame, type GraphFrame, type StackFrame, type ScalarFrame, type TreeFrame } from "../../lib/trace";
import { dijkstraScene, bfsScene, mergeSortScene } from "./scenes";
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

  it("runs as a graph + heap + distance-array + scalar-state scene, in sync (#3268 · #3270)", () => {
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every(isPanelsFrame)).toBe(true);
    expect(Object.keys((frames[0] as PanelsFrame).panels).sort()).toEqual(["distance", "graph", "heap", "state"]);
  });

  it("the priority-queue heap drives the selection then fully drains (#3270)", () => {
    const last = (frames[frames.length - 1] as PanelsFrame).panels;
    expect((last.heap as TreeFrame).nodes).toEqual([]); // every entry popped — the PQ empties
    // The heap actually did work — entries inserted and sifted (swap).
    const heapOps = frames.flatMap((f) => ((f as PanelsFrame).panels.heap as TreeFrame | undefined)?.ops ?? []).map((o) => o.op);
    expect(heapOps).toContain("insert");
    expect(heapOps).toContain("swap");
    // The heap grew past the root at some point (a real tree, not just one node).
    const maxNodes = Math.max(...frames.map((f) => ((f as PanelsFrame).panels.heap as TreeFrame | undefined)?.nodes.length ?? 0));
    expect(maxNodes).toBeGreaterThan(1);
  });

  it("the distance panel ends at the real shortest distances while the graph is fully explored", () => {
    const last = (frames[frames.length - 1] as PanelsFrame).panels;
    // Undirected Dijkstra over WEIGHTED_GRAPH: a=0 c=2 b=3 d=8 e=10 f=13 (node-verified).
    expect((last.distance as ArrayFrame).data).toEqual([0, 3, 2, 8, 10, 13]);
    // The graph co-star shows the exploration. `a` is BOTH the origin and explored (#3378): the anchor
    // lives in `roles`, the walker's state in `marks`, so visiting the start node no longer erases it.
    const graphFrame = last.graph as GraphFrame;
    const graphMarks = graphFrame.marks ?? {};
    expect(graphFrame.roles?.a).toBe("start");
    expect(graphMarks.a).toBe("visited"); // …and it was still explored
    expect(Object.values(graphMarks).filter((m) => m === "visited").length).toBeGreaterThan(0);
  });

  it("the scalar state tracks the settling — the counter reaches every node, the pointer ends on the last (#3268)", () => {
    const last = (frames[frames.length - 1] as PanelsFrame).panels;
    const state = last.state as ScalarFrame;
    expect(state.values.settled).toBe(6);   // all six reachable nodes finalized
    expect(state.values.current).toBe("f"); // the last node settled (largest shortest-path distance)
    expect(state.values.dist).toBe(13);     // its finalized distance
    // The state panel actually moved — some frame `set` the current pointer and some `add`ed to the counter.
    const stateOps = frames.flatMap((f) =>
      Object.values(((f as PanelsFrame).panels.state as ScalarFrame | undefined)?.ops ?? {}).map((o) => o.op),
    );
    expect(stateOps).toContain("set");
    expect(stateOps).toContain("add");
  });
});

describe("registry — dijkstra is now a SCENE (#3259 · #3268 · #3270)", () => {
  it("resolves to a multi-structure example: graph + array + scalar + tree renderers, panel frames", () => {
    const viz = programVizForImpl({ id: "dijkstra.rs", name: "dijkstra" })!;
    expect(viz).toBeDefined();
    expect(viz.renderers.graph).toBeDefined();
    expect(viz.renderers.array).toBeDefined(); // the scene adds the distance array (was graph-only pre-#3259)
    expect(viz.renderers.scalar).toBeDefined(); // the scene adds the scalar state panel (#3268)
    expect(viz.renderers.tree).toBeDefined(); // the scene adds the priority-queue heap panel (#3270)
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
    // EVERY node ends visited — including `a`, which is also the start. Those two facts are only both
    // expressible because roles and marks are separate fields (#3378); with one field the start node had
    // to give up one of them, and it was the origin that lost.
    const graphFrame = last.graph as GraphFrame;
    const graphMarks = graphFrame.marks ?? {};
    expect(graphFrame.roles?.a).toBe("start");
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

describe("TracedScalar — named counters / accumulators / current pointer (#3268)", () => {
  it("set replaces, add accumulates, compare reads without changing", () => {
    const s = new TracedScalar({ n: 0 });
    s.set("cur", "b");
    s.add("n", 3);
    s.add("n", 2);
    expect(s.get("cur")).toBe("b");
    expect(s.get("n")).toBe(5);
    expect(s.compare("n", 10)).toBe(-1); // 5 < 10
    expect(s.get("n")).toBe(5); // compare didn't change the value
  });

  it("records a frame per op — the values snapshot + the op keyed by the touched variable NAME", () => {
    const s = new TracedScalar({ n: 0 });
    s.add("n", 1);
    const frames = s.trace();
    expect(frames[0].values).toEqual({ n: 0 }); // at rest
    const last = frames[frames.length - 1];
    expect(last.values).toEqual({ n: 1 });
    expect(last.ops?.n?.op).toBe("add"); // ops is a per-variable record, not a positional array
  });

  it("add treats a non-numeric / absent variable as 0", () => {
    const s = new TracedScalar();
    s.add("count", 4);
    expect(s.get("count")).toBe(4);
  });
});

describe("TracedTree — trees / heaps / BSTs (#3270)", () => {
  it("insert grows nodes under their parent; the frame carries the parent pointers", () => {
    const t = new TracedTree();
    t.insert("r", 5); // root — no parent
    t.insert("a", 8, "r");
    t.insert("b", 3, "r");
    expect(t.size).toBe(3);
    const last = t.trace().slice(-1)[0];
    expect(last.nodes.map((n) => n.id)).toEqual(["r", "a", "b"]);
    expect(last.nodes.find((n) => n.id === "r")!.parent).toBeUndefined(); // the root has no parent
    expect(last.nodes.find((n) => n.id === "a")!.parent).toBe("r");
    expect(last.ops?.[0]).toMatchObject({ op: "insert", node: "b" }); // last op stamped the new node
  });

  it("swap exchanges two nodes' VALUES (the heap sift) — the tree shape is unchanged", () => {
    const t = new TracedTree([
      { id: "r", value: 9 },
      { id: "a", value: 2, parent: "r" },
    ]);
    t.swap("r", "a");
    expect(t.value("r")).toBe(2); // values exchanged
    expect(t.value("a")).toBe(9);
    const last = t.trace().slice(-1)[0];
    expect(last.nodes.find((n) => n.id === "a")!.parent).toBe("r"); // parent pointer intact
    expect(last.ops?.[0]).toMatchObject({ op: "swap", at: ["r", "a"] });
  });

  it("remove drops a node (and its mark); visit sets a durable current mark", () => {
    const t = new TracedTree([
      { id: "r", value: 1 },
      { id: "a", value: 2, parent: "r" },
    ]);
    t.visit("a");
    expect(t.trace().slice(-1)[0].marks?.a).toBe("current");
    t.remove("a");
    const last = t.trace().slice(-1)[0];
    expect(last.nodes.map((n) => n.id)).toEqual(["r"]); // gone from the tree
    expect(last.marks?.a).toBeUndefined(); // its mark cleared
    expect(last.ops?.[0]).toMatchObject({ op: "remove", node: "a" });
  });
});

describe("cross-panel verbs — compareAcross / move batch two panels into ONE beat (#3286)", () => {
  it("compareAcross flashes both panels' cells in a single frame + returns the comparison", () => {
    let result: number | undefined;
    const prog = (scene: TracedScene) => {
      const a = scene.array("a", [3, 7]);
      const b = scene.array("b", [5, 1]);
      result = scene.compareAcross(a, 0, b, 0); // 3 vs 5
    };
    const frames = [...runScene(prog, null)()];
    expect(result).toBe(-1); // sign(3 - 5)
    expect(frames.length).toBe(2); // beat 0 (rest) + ONE cross-panel beat — not two
    const beat = (frames[1] as PanelsFrame).panels;
    expect((beat.a as ArrayFrame).ops?.[0].op).toBe("compare"); // both panels acted…
    expect((beat.b as ArrayFrame).ops?.[0].op).toBe("compare"); // …in the SAME frame
  });

  it("move writes the destination + highlights the source in one frame", () => {
    const prog = (scene: TracedScene) => {
      const from = scene.array("from", [9, 4]);
      const to = scene.array("to", [0, 0]);
      scene.move(from, 1, to, 0); // 4 → to[0]
    };
    const frames = [...runScene(prog, null)()];
    expect(frames.length).toBe(2);
    const beat = (frames[1] as PanelsFrame).panels;
    expect((beat.to as ArrayFrame).data).toEqual([4, 0]); // the moved value landed
    expect((beat.to as ArrayFrame).ops?.[0].op).toBe("set");
    expect((beat.from as ArrayFrame).ops?.[0].op).toBe("compare"); // source highlighted, same frame
  });
});

describe("mergeSortScene — merge sort as two run-arrays via cross-panel verbs (#3284 · #3286)", () => {
  const input = [5, 2, 9, 1, 6];
  const frames = [...runScene(mergeSortScene, input)()];

  it("runs as an `array` + `leftRun` + `rightRun` scene, in sync", () => {
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every(isPanelsFrame)).toBe(true);
    expect(Object.keys((frames[0] as PanelsFrame).panels).sort()).toEqual(["array", "leftRun", "rightRun"]);
  });

  it("the array panel ends fully sorted", () => {
    const last = (frames[frames.length - 1] as PanelsFrame).panels;
    expect((last.array as ArrayFrame).data).toEqual([1, 2, 5, 6, 9]);
  });

  it("the two runs are compared ACROSS panels, and winners move into the output", () => {
    // compareAcross → compare ops on BOTH run panels; the runs are genuinely distinct structures.
    const leftOps = frames.flatMap((f) => ((f as PanelsFrame).panels.leftRun as ArrayFrame | undefined)?.ops ?? []).map((o) => o.op);
    const rightOps = frames.flatMap((f) => ((f as PanelsFrame).panels.rightRun as ArrayFrame | undefined)?.ops ?? []).map((o) => o.op);
    expect(leftOps).toContain("compare");
    expect(rightOps).toContain("compare");
    // the winners land in the OUTPUT array via `set` (a merge writes, it never swaps).
    const arrOps = frames.flatMap((f) => ((f as PanelsFrame).panels.array as ArrayFrame | undefined)?.ops ?? []).map((o) => o.op);
    expect(arrOps).toContain("set");
    expect(arrOps).not.toContain("swap");
  });
});

describe("registry — merge-sort is now an array-seeded SCENE (#3284)", () => {
  it("resolves to a two-panel scene with the array renderer + a NUMBER-array input seam", () => {
    const viz = programVizForImpl({ id: "merge-sort.rs", name: "merge_sort" })!;
    expect(viz).toBeDefined();
    expect(viz.renderers.array).toBeDefined();
    expect([...viz.factory()].every(isPanelsFrame)).toBe(true); // a scene now, not a flat single array
    // the "your input" seam round-trips a number array, not a graph.
    expect(viz.input.parse("3, 1, 2")).toEqual([3, 1, 2]);
    expect(viz.input.default).not.toContain(":"); // a number list, not an adjacency list ("a: b, c")
  });
});
