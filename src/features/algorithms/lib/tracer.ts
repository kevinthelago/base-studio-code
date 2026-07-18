// The instrumented-execution tracer (#3216, epic #3215) — the mechanism that makes the ACTUAL algorithm
// code drive the animation. Instead of hand-authoring a trace per algorithm, the algorithm runs against a
// TracedArray whose operations are observable: every `compare`/`swap`/`set`/`mark` records a
// StructureFrame, so the animation is DERIVED from the algorithm's real execution. Each algorithm looks
// different because it IS different (bubble's adjacent swaps vs merge's writes vs quick's partitions).
//
// The algorithm is its real logic written against this structure (see viz/examples/sorts.ts) — no `yield`,
// no hand-drawn frames. `runAlgorithm` seeds the structure, runs the algorithm, and exposes the recorded
// trace as a fresh generator per call (replay-safe for the streaming player). Reads via `get` are SILENT
// (the algorithm's internal logic); only meaningful operations record a frame.
//
// This is the array tracer; TracedMatrix / TracedGraph / TracedTree follow the same shape as their
// renderers land (#3179–#3185), so instrumented execution generalizes to every data type.
import type { ArrayFrame, ArrayOp, Frame, GraphFrame, GraphOp, MatrixFrame, MatrixOp, PanelsFrame, ScalarFrame, ScalarOp, StackFrame, StackOp, StructureFrame, TreeFrame, TreeOp } from "./trace";

/** A durable per-cell mark an algorithm can set (matches the ArrayOp `mark` vocabulary). */
export type ArrayMark = "sorted" | "pivot" | "min";

/**
 * An instrumented array — the algorithm operates on it, and every observable operation appends an
 * `ArrayFrame` to the trace. `get` is a silent read (internal logic); `compare`/`swap`/`set`/`mark` are
 * the visible verbs the `<ArrayView>` renderer animates. `cursor` moves a named pointer (drawn on the
 * next frame). Values are numbers (the sort family); the frame carries a fresh snapshot each op.
 */
export class TracedArray {
  private readonly a: number[];
  private readonly log: ArrayFrame[] = [];
  private readonly cur: Record<string, number> = {};

  constructor(input: readonly number[]) {
    this.a = [...input];
    this.emit(); // the initial frame — the input at rest
  }

  /** The length — read freely (no frame). */
  get length(): number {
    return this.a.length;
  }

  /** A silent read of index `i` (the algorithm's internal logic — records no frame). */
  get(i: number): number {
    return this.a[i];
  }

  /** Compare indices `i` and `j` — records a `compare` frame; returns sign(a[i] - a[j]) (`-1|0|1`). */
  compare(i: number, j: number): number {
    this.emit([{ op: "compare", at: [i, j] }]);
    return Math.sign(this.a[i] - this.a[j]);
  }

  /** Swap indices `i` and `j` in place — records a `swap` frame. */
  swap(i: number, j: number): void {
    const t = this.a[i];
    this.a[i] = this.a[j];
    this.a[j] = t;
    this.emit([{ op: "swap", at: [i, j] }]);
  }

  /** Write `v` at index `i` — records a `set` frame. */
  set(i: number, v: number): void {
    this.a[i] = v;
    this.emit([{ op: "set", at: i }]);
  }

  /** Move a named cursor (an `i`/`j` pointer the renderer draws); `null` clears it. Rides the next frame. */
  cursor(name: string, i: number | null): void {
    if (i == null) delete this.cur[name];
    else this.cur[name] = i;
  }

  /** Mark one cell with a durable state (`pivot`/`min`/`sorted`) — records a `mark` frame. */
  mark(i: number, as: ArrayMark): void {
    this.emit([{ op: "mark", at: i, as }]);
  }

  /** Terminal frame — mark every cell `sorted` (the settled resting state a sort ends on). */
  markSorted(): void {
    this.emit(this.a.map((_, k) => ({ op: "mark", at: k, as: "sorted" as const })));
  }

  /** The recorded trace (a fresh snapshot array). */
  trace(): ArrayFrame[] {
    return [...this.log];
  }

  /** Route emitted frames to a {@link TracedScene} (#3259) so this structure can fold into a synchronized
   *  panel. Set once, right after construction; unset ⇒ standalone (single-structure) behavior. */
  private sink?: (f: StructureFrame) => void;
  setSink(fn: (f: StructureFrame) => void): void { this.sink = fn; }

  private emit(ops?: ArrayOp[]): void {
    const frame: ArrayFrame = { structure: "array", data: [...this.a] };
    if (ops && ops.length) frame.ops = ops;
    if (Object.keys(this.cur).length) frame.cursors = { ...this.cur };
    this.log.push(frame);
    this.sink?.(frame);
  }
}

/**
 * Run an algorithm — a plain function over a {@link TracedArray} — on `input`, returning a factory that
 * yields its recorded trace as a FRESH generator each call. The factory is a stable identity (bind it once
 * at the call site) so the streaming player can replay it deterministically; each call re-runs the
 * algorithm from scratch (pure over `input`, which is never mutated).
 */
export function runAlgorithm(algo: (a: TracedArray) => void, input: readonly number[]): () => Generator<Frame> {
  return function* () {
    const a = new TracedArray(input);
    algo(a);
    yield* a.trace();
  };
}

// ── the matrix tracer (#3221) — the 2-D twin of TracedArray ──

/** A cell write for {@link TracedMatrix.writeMany} — a value landing at (row, col). */
export interface CellWrite {
  r: number;
  c: number;
  v: number;
}

/**
 * An instrumented 2-D grid — a matrix algorithm operates on it, and every observable op appends a
 * `MatrixFrame`. `get` is a silent read (internal logic); `read` highlights a cell, `writeMany`/`set`/`swap`
 * are the write verbs the `<MatrixView>` renderer animates, and `region` highlights a rectangular block.
 * A `swap`/rotation writes several cells in ONE frame so they move together.
 */
export class TracedMatrix {
  private readonly m: number[][];
  private readonly log: MatrixFrame[] = [];
  private readonly cur: Record<string, [number, number]> = {};

  constructor(input: readonly (readonly number[])[]) {
    this.m = input.map((row) => [...row]);
    this.emit(); // the grid at rest
  }

  get rows(): number {
    return this.m.length;
  }
  get cols(): number {
    return this.m[0]?.length ?? 0;
  }

  /** A silent read (no frame) — the algorithm's internal logic. */
  get(r: number, c: number): number {
    return this.m[r][c];
  }

  /** Highlight a cell being examined — records a `read` frame. */
  read(r: number, c: number): number {
    this.emit([{ op: "read", at: [r, c] as [number, number] }]);
    return this.m[r][c];
  }

  /** Write several cells in ONE frame (a swap / rotation moves together) — records a `write` op per cell. */
  writeMany(cells: readonly CellWrite[]): void {
    for (const { r, c, v } of cells) this.m[r][c] = v;
    this.emit(cells.map(({ r, c }) => ({ op: "write" as const, at: [r, c] as [number, number] })));
  }

  /** Write one cell — records a `write` frame. */
  set(r: number, c: number, v: number): void {
    this.writeMany([{ r, c, v }]);
  }

  /** Exchange two cells in one frame — the workhorse of transpose / reflect. */
  swap(a: readonly [number, number], b: readonly [number, number]): void {
    const va = this.m[a[0]][a[1]];
    const vb = this.m[b[0]][b[1]];
    this.writeMany([{ r: a[0], c: a[1], v: vb }, { r: b[0], c: b[1], v: va }]);
  }

  /** Highlight a rectangular block (a submatrix / layer), optionally labelled — records a `region` frame. */
  region(rows: [number, number], cols: [number, number], as?: string): void {
    const op: MatrixOp = as ? { op: "region", rows, cols, as } : { op: "region", rows, cols };
    this.emit([op]);
  }

  /** Move a named cursor (drawn on the next frame); `null` clears it. */
  cursor(name: string, at: readonly [number, number] | null): void {
    if (at == null) delete this.cur[name];
    else this.cur[name] = [at[0], at[1]];
  }

  /** The recorded trace (a fresh snapshot). */
  trace(): MatrixFrame[] {
    return [...this.log];
  }

  /** The current grid (fresh copy). */
  values(): number[][] {
    return this.m.map((row) => [...row]);
  }

  /** Route emitted frames to a {@link TracedScene} (#3259) — see {@link TracedArray.setSink}. */
  private sink?: (f: StructureFrame) => void;
  setSink(fn: (f: StructureFrame) => void): void { this.sink = fn; }

  private emit(ops?: MatrixOp[]): void {
    const frame: MatrixFrame = { structure: "matrix", data: this.m.map((row) => [...row]) };
    if (ops && ops.length) frame.ops = ops;
    if (Object.keys(this.cur).length) frame.cursors = { ...this.cur };
    this.log.push(frame);
    this.sink?.(frame);
  }
}

/**
 * Run a matrix algorithm — a plain function over a {@link TracedMatrix} — on `input`, returning a factory
 * that yields its recorded trace as a fresh generator each call (replay-safe; `input` is never mutated).
 */
export function runMatrixAlgorithm(
  algo: (m: TracedMatrix) => void,
  input: readonly (readonly number[])[],
): () => Generator<Frame> {
  return function* () {
    const m = new TracedMatrix(input);
    algo(m);
    yield* m.trace();
  };
}

// ── the graph tracer (#3224) — nodes + edges; traversal / shortest-path verbs ──

/** The topology an algorithm runs against — nodes (with optional coordinates) + (weighted) edges. */
export interface GraphInput {
  nodes: { id: string; label?: string; x?: number; y?: number }[];
  edges: { from: string; to: string; weight?: number }[];
}
/** The WALKER's per-node search state (matches the GraphFrame `marks` vocabulary) — a lifecycle whose
 *  stages legitimately supersede one another: `frontier` → `current` → `visited`. */
export type GraphMark = "visited" | "frontier" | "current";
/** A durable per-node ROLE the algorithm assigns up front (matches the GraphFrame `roles` vocabulary) —
 *  where the search began and where it is headed. Held in its OWN field (#3378) so the walker's state can
 *  never clobber it: every BFS/Dijkstra run visits its own start node, and reaching the goal is exactly
 *  when the goal marking matters most. */
export type GraphRole = "start" | "goal";
/** A neighbour of a node — the other endpoint + the edge weight + the directed edge for `relax`. */
export interface Neighbour {
  to: string;
  weight: number;
  edge: [string, string];
}

/**
 * An instrumented graph — a traversal / shortest-path algorithm operates on it, and every observable op
 * appends a `GraphFrame`. `neighbours` is a silent read (the algorithm's traversal); `frontier` / `visit` /
 * `current` advance the WALKER's durable node `marks` the renderer paints and `relax` fires on an edge —
 * each records a frame. Marks persist across frames; ops are the transient verb. Edges are treated as
 * UNDIRECTED for traversal.
 *
 * `mark()` is a different axis: it assigns a durable ROLE (`start`/`goal`) into the separate `roles` field,
 * so a node can be BOTH the origin and visited (#3378) — which every BFS/Dijkstra start node becomes.
 */
export class TracedGraph {
  private readonly nodes: { id: string; label?: string; x?: number; y?: number }[];
  private readonly edges: { from: string; to: string; weight?: number }[];
  private readonly adj = new Map<string, Neighbour[]>();
  private readonly marks: Record<string, GraphMark> = {};
  private readonly roles: Record<string, GraphRole> = {};
  private readonly cur: Record<string, string> = {};
  private readonly log: GraphFrame[] = [];

  constructor(input: GraphInput) {
    this.nodes = input.nodes.map((n) => ({ ...n }));
    this.edges = input.edges.map((e) => ({ ...e }));
    for (const n of this.nodes) this.adj.set(n.id, []);
    for (const e of this.edges) {
      const w = e.weight ?? 1;
      this.adj.get(e.from)?.push({ to: e.to, weight: w, edge: [e.from, e.to] });
      this.adj.get(e.to)?.push({ to: e.from, weight: w, edge: [e.from, e.to] }); // undirected
    }
    this.emit();
  }

  /** The node ids in declaration order (the algorithm picks a start). */
  ids(): string[] {
    return this.nodes.map((n) => n.id);
  }
  /** A node's coordinates for a spatial heuristic (A*), or `null` when it has none. Silent. */
  coord(id: string): { x: number; y: number } | null {
    const n = this.nodes.find((m) => m.id === id);
    return n && n.x !== undefined && n.y !== undefined ? { x: n.x, y: n.y } : null;
  }
  /** A silent read of a node's neighbours (traversal logic — no frame). UNDIRECTED (both endpoints). */
  neighbours(id: string): Neighbour[] {
    return this.adj.get(id) ?? [];
  }
  /** A silent read of a node's OUTGOING neighbours only (directed, `from → to`) — for topological sort. */
  outNeighbours(id: string): Neighbour[] {
    return this.edges
      .filter((e) => e.from === id)
      .map((e) => ({ to: e.to, weight: e.weight ?? 1, edge: [e.from, e.to] as [string, string] }));
  }
  /** The in-degree of every node (count of incoming directed edges) — Kahn's topological sort. Silent. */
  inDegrees(): Map<string, number> {
    const deg = new Map<string, number>(this.nodes.map((n) => [n.id, 0]));
    for (const e of this.edges) deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
    return deg;
  }

  /** Assign a durable start / goal ROLE (no transient op). Lands in `roles`, a field the traversal verbs
   *  never write — so `visit`/`frontier`/`current` cannot erase it (#3378). */
  mark(id: string, as: GraphRole): void {
    this.roles[id] = as;
    this.emit();
  }
  /** Enqueue/discover a node — a `frontier` op + durable `frontier` mark. */
  frontier(id: string): void {
    this.marks[id] = "frontier";
    this.emit([{ op: "frontier", node: id }]);
  }
  /** Point the `current` cursor at the node being processed (a durable `current` mark). */
  current(id: string): void {
    this.cur.current = id;
    this.marks[id] = "current";
    this.emit();
  }
  /** Finish a node — a `visit` op + durable `visited` mark. */
  visit(id: string): void {
    this.marks[id] = "visited";
    this.emit([{ op: "visit", node: id }]);
  }
  /** Relax / traverse an edge — a `relax` op on `[from, to]`. */
  relax(from: string, to: string): void {
    this.emit([{ op: "relax", edge: [from, to] }]);
  }
  /** Light a final route — a `path` op over the node sequence. */
  path(nodes: string[]): void {
    this.emit([{ op: "path", nodes: [...nodes] }]);
  }

  trace(): GraphFrame[] {
    return [...this.log];
  }

  /** Route emitted frames to a {@link TracedScene} (#3259) — see {@link TracedArray.setSink}. */
  private sink?: (f: StructureFrame) => void;
  setSink(fn: (f: StructureFrame) => void): void { this.sink = fn; }

  private emit(ops?: GraphOp[]): void {
    const frame: GraphFrame = {
      structure: "graph",
      nodes: this.nodes.map((n) => ({ ...n })),
      edges: this.edges.map((e) => ({ ...e })),
    };
    if (ops && ops.length) frame.ops = ops;
    if (Object.keys(this.marks).length) frame.marks = { ...this.marks };
    if (Object.keys(this.roles).length) frame.roles = { ...this.roles };
    if (Object.keys(this.cur).length) frame.cursors = { ...this.cur };
    this.log.push(frame);
    this.sink?.(frame);
  }
}

/**
 * Run a graph algorithm — a plain function over a {@link TracedGraph} — on `input`, returning a factory
 * that yields its recorded trace as a fresh generator each call (replay-safe; `input` is never mutated).
 */
export function runGraphAlgorithm(algo: (g: TracedGraph) => void, input: GraphInput): () => Generator<Frame> {
  return function* () {
    const g = new TracedGraph(input);
    algo(g);
    yield* g.trace();
  };
}

// ── the stack tracer (#3266) — LIFO / FIFO / deque ──

/** The stack discipline — a stack (LIFO), a queue (FIFO), or a double-ended deque. Picks which END
 *  `pop` removes from; `push` always appends to the back/top. */
export type StackMode = "stack" | "queue" | "deque";

/**
 * An instrumented stack / queue / deque — an algorithm's frontier structure (BFS's queue, DFS's stack).
 * `push` appends, `pop` removes the active end (the TOP for a stack/deque, the FRONT for a queue), `peek`
 * reads an index. Every op appends a `StackFrame` the `<StackView>` renderer animates. Values may be
 * strings (e.g. `"b:3"`), so a scene can label frontier entries.
 */
export class TracedStack {
  private readonly s: (number | string)[];
  private readonly mode: StackMode;
  private readonly log: StackFrame[] = [];
  private readonly cur: Record<string, number> = {};

  constructor(mode: StackMode = "stack", initial: readonly (number | string)[] = []) {
    this.s = [...initial];
    this.mode = mode;
    this.emit(); // the structure at rest
  }

  /** The number of entries — read freely (no frame). */
  get size(): number {
    return this.s.length;
  }

  /** Append an entry at the back/top — records a `push` frame. */
  push(v: number | string): void {
    this.s.push(v);
    this.emit([{ op: "push" }]);
  }

  /** Remove + return the active end (the TOP for stack/deque, the FRONT for queue) — records a `pop` frame. */
  pop(): number | string | undefined {
    const v = this.mode === "queue" ? this.s.shift() : this.s.pop();
    this.emit([{ op: "pop" }]);
    return v;
  }

  /** Read the entry at `i` without removing it — records a `peek` frame. */
  peek(i: number): number | string {
    this.emit([{ op: "peek", at: i }]);
    return this.s[i];
  }

  /** Move a named index pointer (drawn on the next frame); `null` clears it. */
  cursor(name: string, i: number | null): void {
    if (i == null) delete this.cur[name];
    else this.cur[name] = i;
  }

  /** The recorded trace (a fresh snapshot array). */
  trace(): StackFrame[] {
    return [...this.log];
  }

  /** Route emitted frames to a {@link TracedScene} (#3259) — see {@link TracedArray.setSink}. */
  private sink?: (f: StructureFrame) => void;
  setSink(fn: (f: StructureFrame) => void): void { this.sink = fn; }

  private emit(ops?: StackOp[]): void {
    const frame: StackFrame = { structure: "stack", data: [...this.s] };
    if (this.mode !== "stack") frame.mode = this.mode;
    if (ops && ops.length) frame.ops = ops;
    if (Object.keys(this.cur).length) frame.cursors = { ...this.cur };
    this.log.push(frame);
    this.sink?.(frame);
  }
}

/**
 * Run a stack/queue algorithm — a plain function over a {@link TracedStack} — returning a factory that
 * yields its recorded trace as a fresh generator each call (replay-safe).
 */
export function runStackAlgorithm(algo: (s: TracedStack) => void, mode: StackMode = "stack"): () => Generator<Frame> {
  return function* () {
    const s = new TracedStack(mode);
    algo(s);
    yield* s.trace();
  };
}

// ── the scalar tracer (#3268) — named counters / accumulators / the current pointer ──

/**
 * Instrumented SCALAR state — the named variables (counters, running sums, min/max, the current pointer)
 * that ride alongside a main structure in almost every larger algorithm. `set`/`add`/`compare` are the
 * verbs the `<ScalarView>` renderer animates; each records a `ScalarFrame` whose `ops` map is keyed by the
 * touched variable NAME (unlike the other structures' positional op arrays). `get` is a silent read.
 * Values may be numbers (counters/sums) or strings (a current node id), mixed per variable.
 */
export class TracedScalar {
  private readonly vals: Record<string, number | string> = {};
  private readonly log: ScalarFrame[] = [];

  constructor(initial: Record<string, number | string> = {}) {
    Object.assign(this.vals, initial);
    this.emit(); // the initial frame — the variables at rest
  }

  /** A silent read of variable `name` (the algorithm's internal logic — records no frame). */
  get(name: string): number | string | undefined {
    return this.vals[name];
  }

  /** Set `name` to `v` — records a `set` frame stamped on that variable. */
  set(name: string, v: number | string): void {
    this.vals[name] = v;
    this.emit({ [name]: { op: "set" } });
  }

  /** Add `delta` to a numeric accumulator `name` (a non-numeric / absent value starts at 0) — records an
   *  `add` frame. */
  add(name: string, delta: number): void {
    const cur = typeof this.vals[name] === "number" ? (this.vals[name] as number) : 0;
    this.vals[name] = cur + delta;
    this.emit({ [name]: { op: "add", delta } });
  }

  /** Compare `name` against `other` — records a `compare` frame; returns sign(value - other) (`-1|0|1`),
   *  treating a non-numeric / absent value as 0. */
  compare(name: string, other: number): number {
    this.emit({ [name]: { op: "compare", other } });
    const cur = typeof this.vals[name] === "number" ? (this.vals[name] as number) : 0;
    return Math.sign(cur - other);
  }

  /** The recorded trace (a fresh snapshot array). */
  trace(): ScalarFrame[] {
    return [...this.log];
  }

  /** Route emitted frames to a {@link TracedScene} (#3259) — see {@link TracedArray.setSink}. */
  private sink?: (f: StructureFrame) => void;
  setSink(fn: (f: StructureFrame) => void): void { this.sink = fn; }

  private emit(ops?: Record<string, ScalarOp>): void {
    const frame: ScalarFrame = { structure: "scalar", values: { ...this.vals } };
    if (ops && Object.keys(ops).length) frame.ops = ops;
    this.log.push(frame);
    this.sink?.(frame);
  }
}

/**
 * Run a scalar-state algorithm — a plain function over a {@link TracedScalar} — returning a factory that
 * yields its recorded trace as a fresh generator each call (replay-safe).
 */
export function runScalarAlgorithm(
  algo: (s: TracedScalar) => void,
  initial: Record<string, number | string> = {},
): () => Generator<Frame> {
  return function* () {
    const s = new TracedScalar(initial);
    algo(s);
    yield* s.trace();
  };
}

// ── the tree tracer (#3270) — trees / heaps / BSTs (parent-pointer nodes) ──

/** A durable per-node tree state (matches the TreeFrame `marks` vocabulary). */
export type TreeMark = "current" | "path" | "target";
/** One tree node — a stable id, its value, and its parent id (absent for the root). */
export interface TreeNode {
  id: string;
  value: number | string;
  parent?: string;
}

/**
 * An instrumented tree (which also models a HEAP or BST) — a tree/heap algorithm operates on it and every
 * observable op appends a `TreeFrame`. Nodes are addressed by a STABLE id; the parent pointers give the
 * `<TreeView>` renderer the shape (it derives the layout). `insert` grows a node, `remove` drops one,
 * `swap` exchanges two nodes' VALUES (the heap sift — positions stay fixed, values move), `visit`/`mark`
 * set a durable state, `compare` fires a transient read. `value` is a silent read.
 */
export class TracedTree {
  private readonly nodes: TreeNode[] = [];
  private readonly byId = new Map<string, TreeNode>();
  private readonly marks: Record<string, TreeMark> = {};
  private readonly log: TreeFrame[] = [];

  constructor(initial: readonly TreeNode[] = []) {
    for (const n of initial) this.addNode(n);
    this.emit(); // the tree at rest
  }

  private addNode(n: TreeNode): void {
    const copy: TreeNode = { id: n.id, value: n.value, ...(n.parent !== undefined ? { parent: n.parent } : {}) };
    this.nodes.push(copy);
    this.byId.set(n.id, copy);
  }

  /** The node count — read freely (no frame). */
  get size(): number {
    return this.nodes.length;
  }

  /** A silent read of a node's value (the algorithm's internal logic — records no frame). */
  value(id: string): number | string | undefined {
    return this.byId.get(id)?.value;
  }

  /** Add a node under `parent` (omit `parent` for the root) — records an `insert` frame stamped on it. */
  insert(id: string, value: number | string, parent?: string): void {
    this.addNode({ id, value, parent });
    // TreeOp.insert requires a `parent`; a root names itself (the frame node's own `parent` stays absent).
    this.emit([{ op: "insert", node: id, parent: parent ?? id }]);
  }

  /** Remove a node (and any durable mark) — records a `remove` frame. */
  remove(id: string): void {
    const i = this.nodes.findIndex((n) => n.id === id);
    if (i >= 0) {
      this.nodes.splice(i, 1);
      this.byId.delete(id);
    }
    delete this.marks[id];
    this.emit([{ op: "remove", node: id }]);
  }

  /** Exchange the VALUES of two nodes (the heap sift — the tree shape is unchanged) — records a `swap`. */
  swap(a: string, b: string): void {
    const na = this.byId.get(a);
    const nb = this.byId.get(b);
    if (na && nb) {
      const t = na.value;
      na.value = nb.value;
      nb.value = t;
    }
    this.emit([{ op: "swap", at: [a, b] }]);
  }

  /** Compare two nodes' values — records a `compare` frame; returns sign(a - b) for numeric values. */
  compare(a: string, b: string): number {
    this.emit([{ op: "compare", at: [a, b] }]);
    const va = this.byId.get(a)?.value;
    const vb = this.byId.get(b)?.value;
    return typeof va === "number" && typeof vb === "number" ? Math.sign(va - vb) : 0;
  }

  /** Finish / touch a node — a `visit` op + durable `current` mark. */
  visit(id: string): void {
    this.marks[id] = "current";
    this.emit([{ op: "visit", node: id }]);
  }

  /** Set a durable node mark (`current`/`path`/`target`) with no transient op. */
  mark(id: string, as: TreeMark): void {
    this.marks[id] = as;
    this.emit();
  }

  /** The recorded trace (a fresh snapshot array). */
  trace(): TreeFrame[] {
    return [...this.log];
  }

  /** Route emitted frames to a {@link TracedScene} (#3259) — see {@link TracedArray.setSink}. */
  private sink?: (f: StructureFrame) => void;
  setSink(fn: (f: StructureFrame) => void): void { this.sink = fn; }

  private emit(ops?: TreeOp[]): void {
    const frame: TreeFrame = {
      structure: "tree",
      nodes: this.nodes.map((n) => ({ ...n })),
    };
    if (ops && ops.length) frame.ops = ops;
    if (Object.keys(this.marks).length) frame.marks = { ...this.marks };
    this.log.push(frame);
    this.sink?.(frame);
  }
}

/**
 * Run a tree/heap algorithm — a plain function over a {@link TracedTree} — returning a factory that yields
 * its recorded trace as a fresh generator each call (replay-safe).
 */
export function runTreeAlgorithm(
  algo: (t: TracedTree) => void,
  initial: readonly TreeNode[] = [],
): () => Generator<Frame> {
  return function* () {
    const t = new TracedTree(initial);
    algo(t);
    yield* t.trace();
  };
}

// ── the scene tracer (#3259) — MULTI-STRUCTURE decomposition ──
//
// A larger algorithm isn't one structure: Dijkstra is a graph + a distance array (+ a heap, later). A
// `TracedScene` hands the algorithm several NAMED structures backed by the same `Traced*` classes, folds
// their ops into ONE synchronized `PanelsFrame` stream, and the player lays the panels side by side. Each
// op on any panel advances a beat whose frame is that panel's op-state + every other panel at its current
// state — so you watch the structures move TOGETHER. `runScene` is the multi-structure `runAlgorithm`.

/** A structure the scene can attach — the existing `Traced*` classes, seen through the two hooks the scene
 *  needs: read the constructor's resting frame, and redirect subsequent frames to the scene. */
interface Sinkable {
  trace(): StructureFrame[];
  setSink(fn: (f: StructureFrame) => void): void;
}

/**
 * A multi-structure trace context (#3259). `scene.array("dist", …)` / `scene.graph("g", …)` return the
 * ordinary `Traced*` instance (so the algorithm uses the SAME `compare`/`swap`/`visit`/`relax` vocabulary),
 * but each op is folded into a synchronized {@link PanelsFrame} keyed by the panel name. The first op emits
 * a resting snapshot of every panel; each op after emits the acting panel's op-frame beside the others at
 * rest. Panels declared before the first op all appear in that resting frame.
 */
export class TracedScene {
  private readonly initial: Record<string, StructureFrame> = {};
  private readonly current: Record<string, StructureFrame> = {};
  private readonly log: PanelsFrame[] = [];
  private started = false;
  private batching = false; // while set, panel ops fold into ONE beat (a cross-panel verb) — see beginBatch

  private attach<T extends Sinkable>(name: string, s: T): T {
    const rest = s.trace()[0]; // the constructor's at-rest frame (structures emit one on creation)
    this.initial[name] = rest;
    this.current[name] = rest;
    s.setSink((f) => {
      this.current[name] = f;
      if (!this.batching) this.pushFrame(); // a batched op just updates `current`; endBatch pushes once
    });
    return s;
  }

  /** Push one synchronized beat — beat 0 (every declared panel at rest) on the first, then the current map. */
  private pushFrame(): void {
    if (!this.started) {
      this.started = true;
      this.log.push({ panels: { ...this.initial } }); // beat 0 — every declared panel at rest
    }
    this.log.push({ panels: { ...this.current } });
  }

  /** Open a CROSS-PANEL beat (#3286): ops on several panels fold into ONE `PanelsFrame` until {@link
   *  endBatch}, so a move / cross-compare animates as a single synchronized step. */
  private beginBatch(): void {
    this.batching = true;
  }
  /** Close the cross-panel beat, emitting the accumulated panel changes as one synchronized frame. */
  private endBatch(): void {
    this.batching = false;
    this.pushFrame();
  }

  /** A named array panel (its `data`/ops render via `<ArrayView>`). */
  array(name: string, input: readonly number[]): TracedArray {
    return this.attach(name, new TracedArray(input));
  }
  /** A named matrix panel (renders via `<MatrixView>`). */
  matrix(name: string, input: readonly (readonly number[])[]): TracedMatrix {
    return this.attach(name, new TracedMatrix(input));
  }
  /** A named graph panel (renders via `<GraphView>`). */
  graph(name: string, input: GraphInput): TracedGraph {
    return this.attach(name, new TracedGraph(input));
  }
  /** A named stack / queue / deque panel (renders via `<StackView>`). */
  stack(name: string, mode: StackMode = "stack", initial: readonly (number | string)[] = []): TracedStack {
    return this.attach(name, new TracedStack(mode, initial));
  }
  /** A named scalar-state panel — counters / accumulators / the current pointer (renders via `<ScalarView>`). */
  scalar(name: string, initial: Record<string, number | string> = {}): TracedScalar {
    return this.attach(name, new TracedScalar(initial));
  }
  /** A named tree / heap / BST panel (parent-pointer nodes; renders via `<TreeView>`). */
  tree(name: string, initial: readonly TreeNode[] = []): TracedTree {
    return this.attach(name, new TracedTree(initial));
  }

  // ── cross-panel verbs (#3286) — operations that span two array panels animate as ONE beat ──

  /**
   * Compare a cell in array panel `a` against a cell in array panel `b` — BOTH cells flash in ONE
   * synchronized beat, returning `sign(a[i] - b[j])`. The cross-panel twin of a single array's `compare`:
   * the merge decision between two runs living in different panels.
   */
  compareAcross(a: TracedArray, i: number, b: TracedArray, j: number): number {
    this.beginBatch();
    a.compare(i, i); // highlight the front of `a` (a self-pair marks just cell i) …
    b.compare(j, j); // … and the front of `b`, in the same beat
    this.endBatch();
    return Math.sign(a.get(i) - b.get(j));
  }

  /**
   * Move the value at `from[i]` into `to[k]` — the source cell highlights and the destination write animate
   * TOGETHER in one beat, so the value visibly slides between panels.
   */
  move(from: TracedArray, i: number, to: TracedArray, k: number): void {
    const v = from.get(i);
    this.beginBatch();
    from.compare(i, i); // the source cell highlights as the value leaves …
    to.set(k, v); // … and lands in the destination, same beat
    this.endBatch();
  }

  /** The recorded synchronized panel trace — a resting snapshot when the program did no ops. */
  frames(): PanelsFrame[] {
    return this.started ? [...this.log] : [{ panels: { ...this.initial } }];
  }
}

/**
 * Run a MULTI-STRUCTURE algorithm against a {@link TracedScene} (#3259) — the scene twin of
 * {@link runAlgorithm}. The program declares its named panels from `input` and drives them; the returned
 * factory yields the synchronized `PanelsFrame` trace as a fresh generator each call (replay-safe).
 */
export function runScene<I>(program: (scene: TracedScene, input: I) => void, input: I): () => Generator<Frame> {
  return function* () {
    const scene = new TracedScene();
    program(scene, input);
    yield* scene.frames();
  };
}
