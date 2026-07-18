// The trace-frame contract (#3176, epic #3171) — the shared, typed skeleton every algorithm-visualization
// frame follows, and the vocabulary the librarian AI writes traces against + every per-structure renderer
// binds to. PURE + React-free (the tests, the streaming engine, and the renderers all share ONE model).
//
// A trace is a stream of FRAMES. Each frame names its `structure`, carries that structure's DATA (or
// topology), and OPTIONALLY carries transient `ops` (the per-frame VERBS the animation binds to),
// `cursors` (named pointers into the structure), and `marks` (durable per-element states). The renderer
// stamps each op/mark onto the element's `data-op` / `data-mark` (see `lib/binding.ts`), and a
// state-triggered kit animation (#3058) fires off that state — so changing the `swap` animation once
// updates every sort visualization, with no hand-coded CSS in any renderer.
//
// A multi-structure algorithm (Dijkstra → graph + heap + distances) yields a `{ panels }` frame whose
// values are per-structure frames animating in sync. `normalizeFrame` collapses the bare-vs-panels split
// so the player always deals with a named map of panels.

/** The data structures a renderer exists for (#3171). Same visual vocabulary as the components'
 *  `DataShape` — one language across both pillars. `tree` also renders heaps; `stack` also renders
 *  queues/deques (via its `mode`); `matrix` also renders grids/DP tables. */
export type StructureName =
  | "array"
  | "matrix"
  | "graph"
  | "linked-list"
  | "tree"
  | "table"
  | "stack"
  | "scalar";

/* ─────────────────────────────── array (also sorts / scans) ─────────────────────────────── */

/** An array VERB (#3171) — the transient per-frame operation the `swap`/`compare`/`set` animations bind
 *  to. `mark` is durable-ish (a cell reaching a terminal state: `sorted`/`pivot`/`min`). `at` is the
 *  cell index, or the index PAIR a compare/swap spans. */
export type ArrayOp =
  | { op: "compare"; at: [number, number] }
  | { op: "swap"; at: [number, number] }
  | { op: "set"; at: number }
  | { op: "mark"; at: number; as: "sorted" | "pivot" | "min" };

/** One frame of an array's evolution. `data` is the current cell values; `cursors` are named pointers
 *  (`{ i: 3, j: 5 }`) a renderer draws as carets under cells. */
export interface ArrayFrame {
  structure: "array";
  data: (number | string)[];
  ops?: ArrayOp[];
  cursors?: Record<string, number>;
}

/* ─────────────────────────────── matrix (also grids / DP tables) ─────────────────────────────── */

/** A matrix VERB (#3171) — a cell `read`/`write` (bound by the `cell-write` animation), or a rectangular
 *  `region` highlight (a DP window / submatrix), optionally labelled via `as`. `at` / `rows` / `cols` are
 *  `[row, col]` / inclusive `[start, end]` index pairs. */
export type MatrixOp =
  | { op: "read"; at: [number, number] }
  | { op: "write"; at: [number, number] }
  | { op: "region"; rows: [number, number]; cols: [number, number]; as?: string };

/** One frame of a 2-D grid's evolution. `heat` opts the renderer into a value→color heat map (magnitude
 *  visualization) rather than printing raw values — for changes-over-time / DP-fill traces. */
export interface MatrixFrame {
  structure: "matrix";
  data: (number | string)[][];
  ops?: MatrixOp[];
  cursors?: Record<string, [number, number]>;
  heat?: boolean;
}

/* ─────────────────────────────── graph (also networks) ─────────────────────────────── */

/** A graph VERB (#3171) — `visit`/`frontier` mark a node's search state (bound by the `visit` animation),
 *  `relax` fires on an edge (Dijkstra/Bellman-Ford, the `relax` animation), `path` lights a final route
 *  (the `path` animation). Nodes are addressed by `id`; edges by their `[from, to]` id pair. */
export type GraphOp =
  | { op: "visit"; node: string }
  | { op: "frontier"; node: string }
  | { op: "relax"; edge: [string, string] }
  | { op: "path"; nodes: string[] };

/**
 * One frame of a graph's evolution. `nodes`/`edges` are the topology; `cursors` are named node pointers
 * (`{ current: "b" }`).
 *
 * Durable per-node state is split across TWO fields (#3378), because "where the algorithm began" and "has
 * the walker been here" are DIFFERENT facts about a node — a node is routinely both:
 *  - `roles` — the anchors the algorithm assigns up front (`start` / `goal`). They outlive the traversal:
 *    every BFS/Dijkstra run eventually walks over its own start node, and the origin must still render as
 *    the origin afterwards.
 *  - `marks` — the WALKER's search state (`frontier` → `current` → `visited`), a lifecycle whose stages
 *    legitimately supersede one another.
 *
 * Keeping them in one field made a traversal state clobber the anchor, so a rendered BFS/Dijkstra could not
 * show its own origin or (once reached) its goal.
 */
export interface GraphFrame {
  structure: "graph";
  nodes: { id: string; label?: string; value?: number | string; x?: number; y?: number }[];
  edges: { from: string; to: string; weight?: number }[];
  ops?: GraphOp[];
  /** The WALKER's per-node search state — transient-lifecycle, each stage superseding the last. */
  marks?: Record<string, "visited" | "frontier" | "current">;
  /** The algorithm's durable per-node anchors — never overwritten by a traversal state (#3378). */
  roles?: Record<string, "start" | "goal">;
  cursors?: Record<string, string>;
}

/* ─────────────────────────────── linked-list ─────────────────────────────── */

/** A linked-list VERB (#3171) — `traverse` walks a node (the `visit` animation), `compare` spans a node
 *  pair, `insert`/`remove` splice at an index, `relink` re-points a `from → to` pointer (the pointer
 *  animation). Nodes are addressed by their positional index in `data`. */
export type ListOp =
  | { op: "traverse"; at: number }
  | { op: "compare"; at: [number, number] }
  | { op: "insert"; at: number }
  | { op: "remove"; at: number }
  | { op: "relink"; from: number; to: number };

/** One frame of a linked list's evolution. `data` is the node values in list order; `doubly` opts into
 *  rendering back-pointers. `cursors` are named pointers (`{ head: 0, cur: 2 }`). */
export interface ListFrame {
  structure: "linked-list";
  data: (number | string)[];
  ops?: ListOp[];
  cursors?: Record<string, number>;
  doubly?: boolean;
}

/* ─────────────────────────────── tree (also heaps / BSTs) ─────────────────────────────── */

/** A tree VERB (#3171) — `visit` (the `visit` animation), `compare` a node pair, `insert`/`remove` a
 *  node, `rotate` a subtree about a pivot (AVL/red-black, the `rotate` animation), `swap` a node pair
 *  (heap sift, the `swap` animation). Nodes are addressed by `id`. */
export type TreeOp =
  | { op: "visit"; node: string }
  | { op: "compare"; at: [string, string] }
  | { op: "insert"; node: string; parent: string }
  | { op: "remove"; node: string }
  | { op: "rotate"; pivot: string; dir: "left" | "right" }
  | { op: "swap"; at: [string, string] };

/** One frame of a tree/heap's evolution. `nodes` carry each node's `value` + its `parent` id (the root's
 *  is absent) — the renderer derives the layout. `marks` are durable per-node states (current/path/target). */
export interface TreeFrame {
  structure: "tree";
  nodes: { id: string; value: number | string; parent?: string }[];
  ops?: TreeOp[];
  marks?: Record<string, "current" | "path" | "target">;
  cursors?: Record<string, string>;
}

/* ─────────────────────────────── table (hash maps / sets) ─────────────────────────────── */

/** A table VERB (#3171) — `read`/`write` a key, `probe` a bucket (open addressing, the probe animation),
 *  `delete` a key. Keyed by the entry `key`; `probe` by bucket index. */
export type TableOp =
  | { op: "read"; key: string }
  | { op: "write"; key: string }
  | { op: "probe"; bucket: number }
  | { op: "delete"; key: string };

/** One frame of a hash table / map. `rows` are the entries (each optionally assigned to a `bucket`);
 *  `buckets` is the table's bucket count (so the renderer can draw empty slots). `cursors` are named
 *  key pointers. */
export interface TableFrame {
  structure: "table";
  rows: { key: string; value: number | string; bucket?: number }[];
  buckets?: number;
  ops?: TableOp[];
  cursors?: Record<string, string>;
}

/* ─────────────────────────────── stack (also queue / deque) ─────────────────────────────── */

/** A stack VERB (#3171) — `push`/`pop` at the active end (the push/pop animations), `peek` at an index.
 *  `push`/`pop` are position-less (the renderer knows the active end from `mode`); `peek` carries `at`. */
export type StackOp =
  | { op: "push" }
  | { op: "pop" }
  | { op: "peek"; at: number };

/** One frame of a LIFO/FIFO. `data` is bottom→top order; `mode` picks the discipline (default `stack`) so
 *  ONE renderer covers stacks, queues, and deques. `cursors` are named index pointers. */
export interface StackFrame {
  structure: "stack";
  data: (number | string)[];
  mode?: "stack" | "queue" | "deque";
  ops?: StackOp[];
  cursors?: Record<string, number>;
}

/* ─────────────────────────────── scalar (counters / accumulators) ─────────────────────────────── */

/** A scalar VERB (#3171) — `set` a value, `add` a delta (accumulators), `compare` against another value.
 *  Keyed (in the frame's `ops` record) by the variable NAME it applies to. */
export type ScalarOp =
  | { op: "set" }
  | { op: "add"; delta: number }
  | { op: "compare"; other: number };

/** One frame of the named scalar variables (counters, sums, min/max, flags). `values` is the current
 *  variable map; `ops` is a per-VARIABLE verb map (keyed by name, unlike the other structures' op arrays);
 *  `timeline` opts into a sparkline of each variable's history rather than a single readout. */
export interface ScalarFrame {
  structure: "scalar";
  values: Record<string, number | string>;
  ops?: Record<string, ScalarOp>;
  timeline?: boolean;
}

/* ─────────────────────────────── the union + the multi-structure frame ─────────────────────────────── */

/** The discriminated union of every single-structure frame — discriminated on `structure`. */
export type StructureFrame =
  | ArrayFrame
  | MatrixFrame
  | GraphFrame
  | ListFrame
  | TreeFrame
  | TableFrame
  | StackFrame
  | ScalarFrame;

/** A multi-structure frame (#3171) — a NAMED map of per-structure panels animating in sync (Dijkstra →
 *  `{ graph, heap, dist }`). The key is the panel's label; each value is a single-structure frame. */
export interface PanelsFrame {
  panels: Record<string, StructureFrame>;
}

/** A trace frame: EITHER a bare single-structure frame OR a multi-panel frame. */
export type Frame = StructureFrame | PanelsFrame;

/** The per-structure frame type for a given structure name — `FrameOf<"array">` is {@link ArrayFrame}.
 *  A renderer for structure `S` is a component over `FrameOf<S>`; the player narrows a panel to its
 *  registered renderer's frame type. */
export type FrameOf<S extends StructureName> = Extract<StructureFrame, { structure: S }>;

/** Type guard: is this frame a multi-panel frame (vs a bare single-structure frame)? */
export function isPanelsFrame(frame: Frame): frame is PanelsFrame {
  return "panels" in frame;
}

/**
 * Collapse the bare-vs-panels split so the player always deals with a NAMED map of panels: a bare
 * single-structure frame becomes `{ main: frame }`; a `{ panels }` frame yields its own map. Pure.
 */
export function normalizeFrame(frame: Frame): Record<string, StructureFrame> {
  return isPanelsFrame(frame) ? frame.panels : { main: frame };
}
