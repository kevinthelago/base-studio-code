// The instrumented-execution tracer (#3216) — TracedArray records the algorithm's real operations as
// frames, and runAlgorithm exposes them as a replay-safe generator.
import { describe, it, expect } from "vitest";
import { TracedArray, runAlgorithm, TracedMatrix, runMatrixAlgorithm, TracedGraph, type GraphInput } from "./tracer";
import type { ArrayFrame, MatrixFrame, GraphFrame } from "./trace";

describe("TracedArray (#3216)", () => {
  it("emits an initial rest frame, then a frame per observable op", () => {
    const a = new TracedArray([3, 1, 2]);
    a.compare(0, 1);
    a.swap(0, 1);
    a.set(2, 9);
    a.mark(2, "pivot");
    const f = a.trace();
    expect(f.length).toBe(5); // initial + compare + swap + set + mark
    expect(f[0].ops).toBeUndefined(); // the input at rest
    expect(f[1].ops).toEqual([{ op: "compare", at: [0, 1] }]);
    expect(f[2].ops).toEqual([{ op: "swap", at: [0, 1] }]);
    expect(f[2].data).toEqual([1, 3, 2]); // the swap is applied to the snapshot
    expect(f[3].ops).toEqual([{ op: "set", at: 2 }]);
    expect(f[3].data).toEqual([1, 3, 9]);
    expect(f[4].ops).toEqual([{ op: "mark", at: 2, as: "pivot" }]);
  });

  it("compare returns the sign; get is a silent read (no frame)", () => {
    const a = new TracedArray([5, 2]);
    expect(a.compare(0, 1)).toBe(1); // 5 > 2
    expect(a.get(0)).toBe(5); // silent
    expect(a.trace().length).toBe(2); // initial + the one compare only
  });

  it("a moved cursor rides the next op frame", () => {
    const a = new TracedArray([1, 2, 3]);
    a.cursor("i", 2);
    a.compare(0, 1);
    expect(a.trace()[1].cursors).toEqual({ i: 2 });
  });

  it("markSorted marks every cell sorted", () => {
    const a = new TracedArray([1, 2]);
    a.markSorted();
    const t = a.trace();
    const last = t[t.length - 1];
    expect(last.ops).toEqual([
      { op: "mark", at: 0, as: "sorted" },
      { op: "mark", at: 1, as: "sorted" },
    ]);
  });
});

describe("runAlgorithm (#3216)", () => {
  it("returns a replay-safe factory and never mutates the input", () => {
    const input = [3, 1, 2];
    const factory = runAlgorithm((a) => a.swap(0, 2), input);
    const first = [...factory()].map((f) => (f as ArrayFrame).data);
    const second = [...factory()].map((f) => (f as ArrayFrame).data);
    expect(second).toEqual(first); // deterministic replay
    expect(input).toEqual([3, 1, 2]); // input untouched
  });
});

// ── #3221 the matrix tracer ──

describe("TracedMatrix (#3221)", () => {
  it("emits an initial rest frame, then a frame per observable op", () => {
    const m = new TracedMatrix([
      [1, 2],
      [3, 4],
    ]);
    m.read(0, 1);
    m.set(0, 0, 9);
    m.swap([0, 1], [1, 0]);
    m.region([0, 1], [0, 1], "block");
    const f = m.trace();
    expect(f.length).toBe(5); // initial + read + set + swap + region
    expect(f[0].ops).toBeUndefined();
    expect(f[1].ops).toEqual([{ op: "read", at: [0, 1] }]);
    expect(f[2].ops).toEqual([{ op: "write", at: [0, 0] }]);
    expect(f[2].data).toEqual([
      [9, 2],
      [3, 4],
    ]);
    // a swap writes BOTH cells in one frame; here (0,1)=2 and (1,0)=3 exchange.
    expect(f[3].ops).toEqual([
      { op: "write", at: [0, 1] },
      { op: "write", at: [1, 0] },
    ]);
    expect(f[3].data).toEqual([
      [9, 3],
      [2, 4],
    ]);
    expect(f[4].ops).toEqual([{ op: "region", rows: [0, 1], cols: [0, 1], as: "block" }]);
  });

  it("get is a silent read; cursors ride the next op frame; rows/cols report dims", () => {
    const m = new TracedMatrix([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect([m.rows, m.cols]).toEqual([2, 3]);
    expect(m.get(1, 2)).toBe(6); // silent — no frame
    m.cursor("p", [1, 2]);
    m.set(0, 0, 0);
    expect(m.trace().length).toBe(2); // initial + the one set (get emitted nothing)
    expect(m.trace()[1].cursors).toEqual({ p: [1, 2] });
  });

  it("runMatrixAlgorithm is replay-safe and never mutates the input", () => {
    const input = [
      [1, 2],
      [3, 4],
    ];
    const factory = runMatrixAlgorithm((m) => m.swap([0, 0], [1, 1]), input);
    const first = [...factory()].map((f) => (f as MatrixFrame).data);
    const second = [...factory()].map((f) => (f as MatrixFrame).data);
    expect(second).toEqual(first);
    expect(input).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });
});

// ── #3224 the graph tracer ──

describe("TracedGraph (#3224)", () => {
  const input: GraphInput = {
    nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ],
  };

  it("exposes undirected neighbours and records frontier/visit/relax verbs + durable marks", () => {
    const g = new TracedGraph(input);
    expect(g.ids()).toEqual(["a", "b", "c"]);
    expect(g.neighbours("b").map((n) => n.to).sort()).toEqual(["a", "c"]); // undirected
    g.frontier("a");
    g.visit("a");
    g.relax("a", "b");
    const f = g.trace();
    expect(f.length).toBe(4); // initial + frontier + visit + relax
    expect(f[1].ops).toEqual([{ op: "frontier", node: "a" }]);
    expect(f[1].marks).toEqual({ a: "frontier" });
    expect(f[2].ops).toEqual([{ op: "visit", node: "a" }]);
    expect(f[2].marks).toEqual({ a: "visited" }); // durable — the mark persists/updates
    expect(f[3].ops).toEqual([{ op: "relax", edge: ["a", "b"] }]);
  });

  // #3378 — the regression that motivated splitting `roles` out of `marks`. `visit()` used to write the
  // node's durable state unconditionally, so it erased the `start` mark `mark()` had set. EVERY BFS and
  // Dijkstra run walks over its own start node, so the origin marking was always destroyed and a rendered
  // traversal could not show where it began. Asserted here at the TracedGraph layer, not only via a scene.
  it("a start node KEEPS its start role after the traversal visits it (#3378)", () => {
    const g = new TracedGraph(input);
    g.mark("a", "start");
    g.frontier("a");
    g.visit("a"); // the walker reaches the origin — this is what used to clobber the role
    const last = g.trace()[g.trace().length - 1];
    expect(last.roles).toEqual({ a: "start" }); // the anchor survived …
    expect(last.marks).toEqual({ a: "visited" }); // … and the walker state is recorded alongside it
  });

  it("a goal node keeps its goal role once the search reaches it (#3378)", () => {
    // `goal` is `start`'s sibling anchor: Dijkstra/A* mark the destination up front, then eventually
    // visit it — precisely the moment the marking matters most, and precisely when it used to vanish.
    const g = new TracedGraph(input);
    g.mark("c", "goal");
    g.current("c");
    g.visit("c");
    const last = g.trace()[g.trace().length - 1];
    expect(last.roles).toEqual({ c: "goal" });
    expect(last.marks).toEqual({ c: "visited" });
  });

  it("the walker's own states still supersede one another — only ROLES are durable (#3378)", () => {
    // The split must not freeze the traversal lifecycle: frontier → current → visited is a progression,
    // and each stage legitimately replaces the last.
    const g = new TracedGraph(input);
    g.frontier("b");
    expect(g.trace().slice(-1)[0].marks).toEqual({ b: "frontier" });
    g.current("b");
    expect(g.trace().slice(-1)[0].marks).toEqual({ b: "current" });
    g.visit("b");
    expect(g.trace().slice(-1)[0].marks).toEqual({ b: "visited" });
    expect(g.trace().slice(-1)[0].roles).toBeUndefined(); // no role was ever assigned
  });

  it("current() sets a cursor + a current mark; every frame carries the full topology", () => {
    const g = new TracedGraph(input);
    g.current("b");
    const last = g.trace()[g.trace().length - 1];
    expect(last.cursors).toEqual({ current: "b" });
    expect(last.marks).toEqual({ b: "current" });
    expect(last.nodes.map((n: GraphFrame["nodes"][number]) => n.id)).toEqual(["a", "b", "c"]);
    expect(last.edges.length).toBe(2);
  });
});
