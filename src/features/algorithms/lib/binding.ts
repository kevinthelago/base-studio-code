// The verb→state binding convention (#3176, epic #3171) — the ONE way every per-structure renderer
// stamps a frame's ops/marks onto an element, so a state-triggered kit animation (#3058) fires the same
// way across all of them. PURE + React-free (returns plain `data-*` attribute objects a renderer spreads
// onto its JSX elements).
//
//   trace verb  →  element `data-op` / `data-mark` state  →  state-triggered kit animation (#3058)
//
// The renderer never writes animation CSS: it only stamps the state. The kit owns the keyframes/timing
// and binds them to `[data-op="swap"]` / `[data-mark="sorted"]` (designed in the Designer). Change the
// `swap` animation once → every sort visualization updates. See docs/algorithm-visualization.md.
//
// The convention: at most ONE op targets a given element per frame (the animation is the transient VERB),
// while a `mark` / `marks` entry is a DURABLE state (a cell reaching `sorted`, a node `visited`). This
// module gives renderers three shared readers so index-, id-, and mark-addressed states stamp identically.

/** The `data-*` state a renderer stamps on an element — a transient op verb and/or a durable mark.
 *  Spread directly onto a JSX element: `<Cell {...opStateAttrs(frame.ops, i)} />`. */
export interface OpStateAttrs {
  /** The transient verb the element is participating in this frame (`swap`/`compare`/`visit`/…). */
  "data-op"?: string;
  /** The durable state the element has reached (`sorted`/`pivot`/`visited`/`current`/…). */
  "data-mark"?: string;
}

/** A NUMERIC-index-addressed op — the shape `opStateAttrs` reads from array / linked-list / stack ops.
 *  `at` is a single index or the `[a, b]` pair a compare/swap spans; `as` carries a `mark` op's state.
 *  Position-less ops (stack `push`/`pop`) carry no `at` and are the renderer's own concern. */
export interface IndexedOp {
  op: string;
  at?: number | [number, number];
  as?: string;
}

/** An ID-addressed op — the shape `nodeOpStateAttrs` reads from graph / tree ops. A node op names its
 *  `node`; an edge op its `edge` `[from, to]`; a path its `nodes`; a compare/swap its `at` id pair. */
export interface NodeOp {
  op: string;
  node?: string;
  nodes?: string[];
  edge?: [string, string];
  at?: [string, string];
}

function targetsIndex(at: IndexedOp["at"], index: number): boolean {
  if (at === undefined) return false;
  return typeof at === "number" ? at === index : at[0] === index || at[1] === index;
}

/**
 * The `data-op` / `data-mark` for the element at numeric position `index` (array / linked-list / stack).
 * An op that targets `index` stamps `data-op` = its verb; a `mark` op stamps `data-mark` = its `as`
 * state instead. Ops without an `at` (stack push/pop) are ignored here. At most one op should target an
 * element per frame (convention); if several do, the last wins. Pure.
 */
export function opStateAttrs(ops: readonly IndexedOp[] | undefined, index: number): OpStateAttrs {
  const attrs: OpStateAttrs = {};
  for (const o of ops ?? []) {
    if (!targetsIndex(o.at, index)) continue;
    if (o.op === "mark" && o.as) attrs["data-mark"] = o.as;
    else attrs["data-op"] = o.op;
  }
  return attrs;
}

/**
 * The `data-op` for the node with id `id` (graph / tree) — set when any op names that id via `node`,
 * `nodes`, `edge`, or `at`. Durable node states come from the frame's `marks` record via
 * {@link markStateAttrs}; this covers the transient VERB. Ops that address no id (a tree `rotate`, which
 * names a `pivot`) are left to the renderer. Last matching op wins. Pure.
 */
export function nodeOpStateAttrs(ops: readonly NodeOp[] | undefined, id: string): OpStateAttrs {
  const attrs: OpStateAttrs = {};
  for (const o of ops ?? []) {
    const hit = o.node === id || !!o.nodes?.includes(id) || !!o.edge?.includes(id) || !!o.at?.includes(id);
    if (hit) attrs["data-op"] = o.op;
  }
  return attrs;
}

/**
 * The `data-mark` for a keyed element from a frame's durable `marks` record (graph node search state,
 * tree node state, …). Empty when the key has no mark. Pure.
 */
export function markStateAttrs(marks: Record<string, string> | undefined, key: string): OpStateAttrs {
  const mark = marks?.[key];
  return mark ? { "data-mark": mark } : {};
}

/** A 2-D-addressed op — the shape `cellOpStateAttrs` reads from matrix ops (#3221). A cell op names its
 *  `at` `[row, col]`; a `region` op names its `rows`/`cols` inclusive ranges (with an optional `as` label). */
export interface CellOp {
  op: string;
  at?: [number, number];
  rows?: [number, number];
  cols?: [number, number];
  as?: string;
}

/**
 * The `data-op` / `data-mark` for the cell at (`row`, `col`) in a matrix. A `read`/`write` op that targets
 * the cell stamps `data-op` = its verb; a `region` op covering the cell stamps `data-mark` = its `as` label
 * (or `data-op` = "region" when unlabelled). Last matching op wins. Pure — the 2-D twin of {@link
 * opStateAttrs}.
 */
export function cellOpStateAttrs(ops: readonly CellOp[] | undefined, row: number, col: number): OpStateAttrs {
  const attrs: OpStateAttrs = {};
  for (const o of ops ?? []) {
    if (o.at && o.at[0] === row && o.at[1] === col) {
      attrs["data-op"] = o.op;
    } else if (
      o.rows &&
      o.cols &&
      row >= o.rows[0] &&
      row <= o.rows[1] &&
      col >= o.cols[0] &&
      col <= o.cols[1]
    ) {
      if (o.as) attrs["data-mark"] = o.as;
      else attrs["data-op"] = "region";
    }
  }
  return attrs;
}
