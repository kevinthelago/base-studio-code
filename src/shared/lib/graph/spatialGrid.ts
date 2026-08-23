// A uniform spatial grid over node positions — the index that makes hit-testing and viewport queries
// cost something other than "look at every node" (`gpu-graph-slice-1-renderer-core`).
//
// WHY THIS EXISTS. The DOM graph answers "which nodes are visible" with `isNodeVisible` called once per
// node per commit — an O(N) scan on the main thread. Measured on the live Design Studio graph, the whole
// per-interaction cost is linear at ~19 µs per DOM element (402 nodes ⇒ 99 ms, 8,002 ⇒ 1,051 ms), and a
// per-frame O(N) scan is part of what keeps it that way. At a million nodes an O(N) scan per mousemove is
// not a slow feature, it is a hung window.
//
// WHY A GRID AND NOT A QUADTREE. Build is O(n) rather than O(n log n), lookup is arithmetic rather than
// pointer-chasing, and the whole structure is two flat typed arrays — no per-node objects, so it costs
// ~8 bytes per node and nothing for the GC to walk. A quadtree wins on adversarial clustering; a layered
// DAG layout (`layerDag` + `orderLayers`, which is what feeds this) spreads nodes across rows by
// construction, so the clustering a quadtree defends against is not the distribution we have.
//
// THE STRUCTURE IS A COUNTING SORT. `cellStart` holds the prefix sums and `items` holds node indices
// grouped by cell, so cell `c` owns `items[cellStart[c] .. cellStart[c+1])`. That is the cache-friendly
// shape: one pass to count, one prefix sum, one pass to scatter, and every subsequent read is a
// contiguous run. The obvious alternative — an array of arrays — allocates `cells` objects and scatters
// the reads across the heap.
//
// PURE. No DOM, no GL, no React. Every complexity claim below is asserted in `spatialGrid.test.ts`,
// including a scaling test that fails if `pickNearest` starts to look linear.

/** The grid. All fields are read-only views over two typed arrays plus the transform that addresses them. */
export interface SpatialGrid {
  /** Number of nodes indexed. */
  readonly count: number;
  readonly cols: number;
  readonly rows: number;
  /** World units per cell, on both axes. */
  readonly cellSize: number;
  /** World-space origin of cell (0,0). */
  readonly minX: number;
  readonly minY: number;
  /** Prefix sums, length `cols*rows + 1`. Cell `c` owns `items[cellStart[c] .. cellStart[c+1])`. */
  readonly cellStart: Uint32Array;
  /** Node indices, grouped by cell. Length `count`. */
  readonly items: Uint32Array;
}

/**
 * How many nodes we aim to put in each cell.
 *
 * Two is the balance point, and it is a real trade rather than a preference. Lower means more cells:
 * the grid allocates `cols*rows+1` u32s and a rect query touches more of them, so memory and the
 * per-query constant both rise. Higher means longer runs to scan inside each cell, which is what turns
 * `pickNearest` from O(1)-expected back toward linear. Two keeps a point query looking at ~18 nodes
 * across the 3×3 cell neighbourhood it must consider.
 */
const TARGET_PER_CELL = 2;

/**
 * Hard ceiling on `cols*rows`, independent of `count`.
 *
 * Without it a degenerate distribution — a few thousand nodes with one outlier a million units away —
 * yields a tiny `cellSize` against a vast bounding box and asks for an allocation big enough to kill the
 * tab. The cap grows the cell instead, which costs query time on a pathological input and nothing at all
 * on a sane one. Failing slower is always better than failing with an out-of-memory.
 */
const MAX_CELLS = 1 << 22;

/**
 * Build the index. `xy` is interleaved `[x0,y0, x1,y1, …]`; only the first `count` pairs are read.
 *
 * O(n) — three linear passes (bounds, count, scatter) plus an O(cells) prefix sum, and `cells` is
 * proportional to `n` by construction. No allocation per node.
 *
 * A non-finite coordinate is CLAMPED into the grid rather than rejected: this runs on the render path,
 * and a NaN that drops a node out of the index makes it invisible AND unpickable — a node you can see
 * but cannot click is a worse failure than one drawn at the edge.
 */
export function buildGrid(xy: Float32Array, count: number, targetPerCell = TARGET_PER_CELL): SpatialGrid {
  const n = Math.max(0, Math.min(count, xy.length >> 1));
  if (n === 0) {
    return { count: 0, cols: 1, rows: 1, cellSize: 1, minX: 0, minY: 0, cellStart: new Uint32Array(2), items: new Uint32Array(0) };
  }
  // Pass 1 — bounds. Non-finite values are skipped here so one NaN cannot swallow the whole extent;
  // they are still placed (clamped) in the scatter pass below.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = xy[i * 2], y = xy[i * 2 + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  // Every coordinate was non-finite, or there is exactly one distinct point: a single cell is correct
  // and every query degenerates to "scan the one bucket", which is what a one-point index should do.
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) { minX = 0; minY = 0; maxX = 0; maxY = 0; }

  const spanX = Math.max(maxX - minX, 0);
  const spanY = Math.max(maxY - minY, 0);
  // Aim for `n / targetPerCell` cells spread over the bounding area. A zero-area span (all nodes on one
  // row or one point) has no meaningful density, so fall back to a unit cell and let the cap below
  // decide the resolution.
  const area = spanX * spanY;
  let cellSize = area > 0 ? Math.sqrt((area * targetPerCell) / n) : 1;
  if (!Number.isFinite(cellSize) || cellSize <= 0) cellSize = 1;

  let cols = Math.max(1, Math.ceil(spanX / cellSize) || 1);
  let rows = Math.max(1, Math.ceil(spanY / cellSize) || 1);
  // Grow the cell until the grid fits the cap. Each doubling quarters the cell count, so this converges
  // in a handful of iterations from any starting point.
  while (cols * rows > MAX_CELLS) {
    cellSize *= 2;
    cols = Math.max(1, Math.ceil(spanX / cellSize) || 1);
    rows = Math.max(1, Math.ceil(spanY / cellSize) || 1);
  }

  const cells = cols * rows;
  // Length `cells + 1` and counted at `cell + 1`, so after the prefix sum `cellStart[c]` is already the
  // start of cell `c` and `cellStart[c+1]` its end — no separate end array, no off-by-one at the tail.
  const cellStart = new Uint32Array(cells + 1);
  const cellOf = (x: number, y: number): number => {
    const cx = clampInt(Math.floor((x - minX) / cellSize), cols);
    const cy = clampInt(Math.floor((y - minY) / cellSize), rows);
    return cy * cols + cx;
  };
  // Pass 2 — count.
  for (let i = 0; i < n; i++) cellStart[cellOf(xy[i * 2], xy[i * 2 + 1]) + 1]++;
  // Prefix sum.
  for (let c = 1; c <= cells; c++) cellStart[c] += cellStart[c - 1];
  // Pass 3 — scatter. `cursor` starts as a copy of the offsets and is consumed as it fills.
  const cursor = cellStart.slice(0, cells);
  const items = new Uint32Array(n);
  for (let i = 0; i < n; i++) items[cursor[cellOf(xy[i * 2], xy[i * 2 + 1])]++] = i;

  return { count: n, cols, rows, cellSize, minX, minY, cellStart, items };
}

/** Floor-to-cell with clamping, so a non-finite or out-of-range coordinate lands in a real cell. */
function clampInt(v: number, len: number): number {
  return v < 0 || !Number.isFinite(v) ? 0 : v >= len ? len - 1 : v | 0;
}

/**
 * Write the indices of every node inside the world-space rect into `out`; returns how many were written.
 *
 * O(k + cellsTouched) where k is the number of nodes in the touched cells — independent of total node
 * count. The caller owns `out` so a per-frame query allocates NOTHING; when it is too small the result
 * is TRUNCATED and the return value says so, because growing it here would hand the render path an
 * allocation it cannot budget for.
 *
 * This tests cell membership, not exact containment: a node in a touched cell is reported even if it
 * sits just outside the rect. That is deliberate and matches `CULL_MARGIN_VIEWPORTS` — over-reporting
 * costs a few instances in a draw call that is already measured at 1.55 ms per million, while
 * under-reporting is a node missing from the screen.
 */
export function queryRect(g: SpatialGrid, x: number, y: number, w: number, h: number, out: Uint32Array): number {
  if (g.count === 0 || out.length === 0) return 0;
  const c0 = clampInt(Math.floor((x - g.minX) / g.cellSize), g.cols);
  const c1 = clampInt(Math.floor((x + w - g.minX) / g.cellSize), g.cols);
  const r0 = clampInt(Math.floor((y - g.minY) / g.cellSize), g.rows);
  const r1 = clampInt(Math.floor((y + h - g.minY) / g.cellSize), g.rows);
  let m = 0;
  for (let r = r0; r <= r1; r++) {
    const rowBase = r * g.cols;
    // One contiguous run per ROW rather than per cell: cells within a row are adjacent in `items`, so a
    // whole row of the query rect is a single span and `subarray`-free copy loop.
    const start = g.cellStart[rowBase + c0];
    const end = g.cellStart[rowBase + c1 + 1];
    for (let k = start; k < end; k++) {
      if (m >= out.length) return m;
      out[m++] = g.items[k];
    }
  }
  return m;
}

/**
 * The node nearest to (`x`,`y`) within `maxRadius` world units, or -1.
 *
 * O(1) expected: the search visits the cells within `maxRadius` of the point, and cell occupancy is
 * bounded by `targetPerCell` in expectation, so the work does not grow with node count. That is the
 * property `pickNearest_does_not_degrade_toward_linear` asserts.
 *
 * `radii` gives each node's own hit radius — pass a number for a uniform one. A node is a candidate only
 * when the point is inside ITS radius, so a big node still wins over a small one that happens to be a
 * little closer to the cursor, which is what makes clicking feel right.
 */
export function pickNearest(
  g: SpatialGrid,
  xy: Float32Array,
  radii: Float32Array | number,
  x: number,
  y: number,
  maxRadius: number,
): number {
  if (g.count === 0) return -1;
  const reach = Math.max(0, maxRadius);
  const c0 = clampInt(Math.floor((x - reach - g.minX) / g.cellSize), g.cols);
  const c1 = clampInt(Math.floor((x + reach - g.minX) / g.cellSize), g.cols);
  const r0 = clampInt(Math.floor((y - reach - g.minY) / g.cellSize), g.rows);
  const r1 = clampInt(Math.floor((y + reach - g.minY) / g.cellSize), g.rows);
  let best = -1;
  // Squared throughout — a hit test does not need the square root, and skipping it removes one sqrt per
  // candidate from a path that runs on every mousemove.
  let bestD2 = Infinity;
  for (let r = r0; r <= r1; r++) {
    const rowBase = r * g.cols;
    const start = g.cellStart[rowBase + c0];
    const end = g.cellStart[rowBase + c1 + 1];
    for (let k = start; k < end; k++) {
      const i = g.items[k];
      const dx = xy[i * 2] - x, dy = xy[i * 2 + 1] - y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= bestD2) continue;
      const rad = typeof radii === "number" ? radii : radii[i];
      if (d2 > rad * rad) continue;
      bestD2 = d2;
      best = i;
    }
  }
  return best;
}
