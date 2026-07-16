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
import type { ArrayFrame, ArrayOp, Frame, GraphFrame, GraphOp, MatrixFrame, MatrixOp } from "./trace";

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

  private emit(ops?: ArrayOp[]): void {
    const frame: ArrayFrame = { structure: "array", data: [...this.a] };
    if (ops && ops.length) frame.ops = ops;
    if (Object.keys(this.cur).length) frame.cursors = { ...this.cur };
    this.log.push(frame);
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

  private emit(ops?: MatrixOp[]): void {
    const frame: MatrixFrame = { structure: "matrix", data: this.m.map((row) => [...row]) };
    if (ops && ops.length) frame.ops = ops;
    if (Object.keys(this.cur).length) frame.cursors = { ...this.cur };
    this.log.push(frame);
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

/** The topology an algorithm runs against — nodes + (weighted) edges. */
export interface GraphInput {
  nodes: { id: string; label?: string }[];
  edges: { from: string; to: string; weight?: number }[];
}
/** A durable per-node search state (matches the GraphFrame `marks` vocabulary). */
export type GraphMark = "start" | "goal" | "visited" | "frontier" | "current";
/** A neighbour of a node — the other endpoint + the edge weight + the directed edge for `relax`. */
export interface Neighbour {
  to: string;
  weight: number;
  edge: [string, string];
}

/**
 * An instrumented graph — a traversal / shortest-path algorithm operates on it, and every observable op
 * appends a `GraphFrame`. `neighbours` is a silent read (the algorithm's traversal); `frontier` / `visit` /
 * `current` set DURABLE node marks the renderer paints and `relax` fires on an edge — each records a frame.
 * Marks persist across frames; ops are the transient verb. Edges are treated as UNDIRECTED for traversal.
 */
export class TracedGraph {
  private readonly nodes: { id: string; label?: string }[];
  private readonly edges: { from: string; to: string; weight?: number }[];
  private readonly adj = new Map<string, Neighbour[]>();
  private readonly marks: Record<string, GraphMark> = {};
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
  /** A silent read of a node's neighbours (traversal logic — no frame). */
  neighbours(id: string): Neighbour[] {
    return this.adj.get(id) ?? [];
  }

  /** Set a durable start / goal mark (no transient op). */
  mark(id: string, as: GraphMark): void {
    this.marks[id] = as;
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

  private emit(ops?: GraphOp[]): void {
    const frame: GraphFrame = {
      structure: "graph",
      nodes: this.nodes.map((n) => ({ ...n })),
      edges: this.edges.map((e) => ({ ...e })),
    };
    if (ops && ops.length) frame.ops = ops;
    if (Object.keys(this.marks).length) frame.marks = { ...this.marks };
    if (Object.keys(this.cur).length) frame.cursors = { ...this.cur };
    this.log.push(frame);
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
