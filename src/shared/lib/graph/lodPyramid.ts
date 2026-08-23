// A mipmap over SPACE — the structure that makes frame cost stop referencing the node count
// (`gpu-graph-slice-4-lod-pyramid`).
//
// WHY THIS IS STILL NEEDED WHEN A MILLION NODES ALREADY DRAW IN 1.55 ms. Measured in this app's own
// webview, node quads scale fine and EDGES do not — they are fill-bound: 5M wide quads 13.2 ms, 10M
// 22.2 ms (over a 16.7 ms budget), 20M 37.6 ms. A million nodes usually means 2-10M edges, so the edge
// pass is already the ceiling and at 10M+ nodes the node pass joins it. Drawing faster cannot fix that;
// not drawing the invisible can.
//
// AND IT IS NOT ONLY ABOUT SPEED. A million nodes at overview zoom is a grey rectangle — every node is
// sub-pixel and every edge overlaps everything. The aggregate is the more HONEST picture at that scale,
// so the level the user should be looking at is the one that is also cheap.
//
// THE SHAPE. Level 0 is the nodes. Level k aggregates them into grid cells of `base * 2^k`, and each
// non-empty cell becomes one node at its members' centroid carrying how many it stands for. Each level
// is built from the one below, over a population that shrinks geometrically, so the whole pyramid is
// O(n) — not O(n log n), because the work per level falls off faster than the level count rises.
//
// EDGES ARE DROPPED ABOVE A LEVEL, NOT AGGREGATED. Aggregating them means mapping every edge onto its
// endpoints' clusters and deduping — O(E) per level with a hash — to produce a hairball nobody can read.
// Dropping is cheaper AND more legible: the aggregates already carry the density the edges conveyed.
//
// PURE. Numbers in, numbers out — which is what lets "the drawn count does not grow with n" be an
// assertion rather than a hope.

/** One level of the pyramid. `xy` is interleaved centroids; `count[i]` is how many level-0 nodes it stands for. */
export interface LodLevel {
  /** Interleaved `[x,y]` per aggregate. */
  xy: Float32Array;
  /** How many original nodes each aggregate represents. 1 at level 0. */
  count: Uint32Array;
  /** Number of aggregates. */
  n: number;
  /** World units per grid cell at this level — `base * 2^k`. */
  cellSize: number;
}

export interface LodPyramid {
  levels: LodLevel[];
  /** Cell size of level 1; level k is `base * 2^(k-1)`. Level 0 is the raw nodes. */
  base: number;
  minX: number;
  minY: number;
}

/**
 * Stop building once a level is this small.
 *
 * Below it the aggregates are fewer than a screen could usefully show and each further level halves
 * almost nothing, so the remaining levels cost storage and buy no reduction.
 */
const MIN_LEVEL_NODES = 64;

/** Hard cap on levels, so a degenerate extent cannot spin. */
const MAX_LEVELS = 24;

/**
 * Build the pyramid — `O(n)` total.
 *
 * Level k+1 is built from level k, and each level has at most a quarter of the previous one's
 * aggregates once the cell size doubles in both axes, so the total work is `n * (1 + 1/4 + 1/16 + …)`,
 * which converges below `4n/3`. Storage converges the same way, which is why the whole pyramid costs a
 * small multiple of the original rather than a multiple of the level count.
 *
 * `base` defaults to the spacing that puts ~2 nodes in a level-1 cell, matching `buildGrid`'s density
 * target so the two structures agree about what "close" means.
 */
export function buildPyramid(xy: Float32Array, count: number, base?: number): LodPyramid {
  const n = Math.max(0, Math.min(count, xy.length >> 1));
  const level0: LodLevel = {
    xy: xy.subarray(0, n * 2),
    count: (() => { const c = new Uint32Array(n); c.fill(1); return c; })(),
    n,
    cellSize: 0,
  };
  if (n === 0) return { levels: [level0], base: 1, minX: 0, minY: 0 };

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = xy[i * 2], y = xy[i * 2 + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 0; maxY = 0; }
  const area = Math.max(maxX - minX, 0) * Math.max(maxY - minY, 0);
  let cell = base ?? (area > 0 ? Math.sqrt((area * 2) / n) : 1);
  if (!Number.isFinite(cell) || cell <= 0) cell = 1;

  const levels: LodLevel[] = [level0];
  let src = level0;
  for (let k = 0; k < MAX_LEVELS && src.n > MIN_LEVEL_NODES; k++) {
    const next = aggregate(src, cell, minX, minY);
    // No reduction means the extent is degenerate for this cell size — doubling again would loop
    // without shrinking, so stop rather than spin.
    if (next.n >= src.n) break;
    levels.push(next);
    src = next;
    cell *= 2;
  }
  return { levels, base: base ?? levels[1]?.cellSize ?? 1, minX, minY };
}

/**
 * Collapse a level into grid cells of `cell`, one aggregate per non-empty cell — `O(m)` for `m` inputs.
 *
 * Centroid is WEIGHTED by each input's own count, so an aggregate always sits at the centre of mass of
 * the original nodes beneath it rather than drifting toward whichever branch happened to have more
 * aggregates. Without the weight the position would depend on the pyramid's own shape, not the data's.
 */
function aggregate(src: LodLevel, cell: number, minX: number, minY: number): LodLevel {
  const buckets = new Map<number, number>(); // cell key -> index into the output
  const sx: number[] = [];
  const sy: number[] = [];
  const cnt: number[] = [];
  for (let i = 0; i < src.n; i++) {
    const x = src.xy[i * 2], y = src.xy[i * 2 + 1];
    const cx = Math.floor((x - minX) / cell);
    const cy = Math.floor((y - minY) / cell);
    // Packed into one number rather than a string key: a string key here allocates once per input node,
    // which at a million nodes is the dominant cost of the whole build.
    const key = cx * 4294967296 + cy;
    let at = buckets.get(key);
    if (at === undefined) {
      at = sx.length;
      buckets.set(key, at);
      sx.push(0); sy.push(0); cnt.push(0);
    }
    const w = src.count[i];
    sx[at] += x * w;
    sy[at] += y * w;
    cnt[at] += w;
  }
  const m = sx.length;
  const out = new Float32Array(m * 2);
  const oc = new Uint32Array(m);
  for (let i = 0; i < m; i++) {
    out[i * 2] = sx[i] / cnt[i];
    out[i * 2 + 1] = sy[i] / cnt[i];
    oc[i] = cnt[i];
  }
  return { xy: out, count: oc, n: m, cellSize: cell };
}

/**
 * Minimum on-screen separation, in px, that a drawn aggregate must have from its neighbours.
 *
 * This is the knob that converts "how zoomed out am I" into "how much may I draw", and it is a
 * LEGIBILITY threshold like the label gate: below a few px, adjacent nodes are the same pixel and
 * drawing both is paying twice for one dot.
 */
export const MIN_SEPARATION_PX = 4;

/**
 * Which level to draw at this zoom — `O(1)`.
 *
 * Picks the coarsest level whose cell still covers at least `MIN_SEPARATION_PX` on screen, so the drawn
 * population is bounded by viewport area divided by that separation — independent of how many nodes
 * exist. Monotonic in `scale` by construction: a smaller scale can only select an equal or coarser
 * level, which is what stops the view from flickering between levels as you zoom.
 */
export function levelFor(p: LodPyramid, scale: number): number {
  if (p.levels.length <= 1 || !(scale > 0)) return 0;
  for (let k = 0; k < p.levels.length; k++) {
    // Level 0 has no cell of its own; its natural spacing is finer than a level-1 cell, and `base` was
    // chosen for ~2 nodes per level-1 cell, so half of it is the honest estimate.
    const sep = k === 0 ? p.base / 2 : p.levels[k].cellSize;
    if (sep * scale >= MIN_SEPARATION_PX) return k;
  }
  // Zoomed out past even the coarsest level — draw that, which is the fewest aggregates there are.
  return p.levels.length - 1;
}
