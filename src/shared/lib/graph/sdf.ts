// Exact Euclidean distance transform, and the signed field built from it (`gpu-graph-slice-2-labels`).
//
// WHY A DISTANCE FIELD AT ALL. The graph is a pan/zoom surface. A bitmap glyph atlas is correct only
// near the size it was rasterized at — it blurs on the way in and aliases on the way out — and text
// that degrades as you zoom is the thing a graph is FOR. A signed distance field is one texture
// sampled with a `smoothstep` whose width comes from the screen derivative, so a glyph is crisp at
// every scale. The cost is per-PIXEL, not per-node, so it does not grow with the graph.
//
// WHY EXACT AND NOT APPROXIMATE. The usual runtime shortcut is a chamfer/8SSEDT approximation, which
// is a few percent wrong on diagonals. On a distance FIELD that error lands exactly where glyph
// outlines are most diagonal — the shoulders of an 'a', the apex of an 'A' — and reads as a wobbling
// edge when you zoom. Felzenszwalb-Huttenlocher is exact and still O(pixels): two separable passes of
// a 1D transform whose inner loop is amortized O(1) per column.
//
// PURE. No canvas, no GL, no DOM — it takes an array of numbers and returns one. That is what lets the
// exactness claim be tested against a brute-force nearest-pixel search rather than eyeballed, which is
// the only way anyone would ever notice it was subtly wrong.

/** Squared distances, so nothing here takes a square root until the caller asks for one. */
const INF = 1e20;

/**
 * The 1D squared-distance transform of a sampled function, in place.
 *
 * `f[q]` is the cost at position q; the result is `min over p of (f[p] + (q-p)^2)`. Feeding it 0 at
 * "inside" pixels and INF elsewhere makes it a distance transform; running it per column and then per
 * row makes that distance Euclidean, which is the separability the algorithm exists for.
 *
 * The scratch arrays are passed in because this is called once per row AND once per column of every
 * glyph — allocating them here would allocate twice per pixel of the atlas.
 *
 * `v` holds the indices of parabolas in the lower envelope and `z` the boundaries between them; the
 * `while` pops parabolas that have been overtaken, which is what makes the whole pass amortized O(n).
 */
export function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/**
 * Squared Euclidean distance from every pixel to the nearest pixel where `inside` is true — `O(W*H)`.
 *
 * Returns squared distances; the caller takes the root once, on the values it actually keeps.
 */
export function edt2d(inside: Uint8Array, w: number, h: number): Float64Array {
  const grid = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) grid[i] = inside[i] ? 0 : INF;
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  // Columns first, then rows. Order does not matter mathematically — the transform is separable — but
  // doing columns first keeps the row pass reading contiguous memory, which is the hot one.
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = grid[row + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) grid[row + x] = d[x];
  }
  return grid;
}

/**
 * A signed distance field, encoded to bytes for an R8 texture.
 *
 * `alpha` is a rasterized glyph's coverage (0-255); a pixel counts as inside above `threshold`. The
 * signed distance is `outside - inside`, so it is negative within the glyph and positive without, and
 * it is mapped into 0..255 with 0.5 at the edge — the value the shader compares against.
 *
 * `spread` is how many pixels the field covers either side of the outline. Too small and the shader
 * has no gradient to antialias against when zoomed in; too large and precision is wasted on distances
 * nothing samples. 8 is the usual working value for text at these sizes.
 */
export function signedDistanceField(
  alpha: Uint8Array,
  w: number,
  h: number,
  spread = 8,
  threshold = 128,
): Uint8Array {
  const inside = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) inside[i] = alpha[i] >= threshold ? 1 : 0;
  const outsideD = edt2d(inside, w, h);
  // The complement's transform gives the distance from an inside pixel to the nearest OUTSIDE one.
  // Both are needed: a field built from one side only is flat within the glyph, and the shader's
  // antialiasing has nothing to work with on the inner edge.
  const flipped = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) flipped[i] = inside[i] ? 0 : 1;
  const insideD = edt2d(flipped, w, h);

  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const dist = inside[i] ? -Math.sqrt(insideD[i]) : Math.sqrt(outsideD[i]);
    // Clamp AFTER mapping so the byte range is used symmetrically around the edge value.
    const v = 0.5 - dist / (2 * spread);
    out[i] = Math.max(0, Math.min(255, Math.round(v * 255)));
  }
  return out;
}
