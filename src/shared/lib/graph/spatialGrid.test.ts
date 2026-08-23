// The index's correctness AND its complexity. The second half is the point: a spatial index that is
// merely correct but degrades to a scan has replaced an O(N) loop with a slower O(N) loop.
import { describe, it, expect } from "vitest";
import { buildGrid, queryRect, pickNearest, type SpatialGrid } from "@/shared/lib/graph/spatialGrid";

/** Deterministic RNG — a timing-free test that seeds from Math.random is a test that fails on a Friday. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function uniform(n: number, extent: number, seed = 1): Float32Array {
  const r = rng(seed);
  const xy = new Float32Array(n * 2);
  for (let i = 0; i < n * 2; i++) xy[i] = r() * extent;
  return xy;
}

/**
 * How many nodes a `pickNearest` at (x,y) would actually examine — the per-call cost, computed from the
 * grid's own fields rather than from a clock.
 *
 * Deliberately NOT a wall-time measurement. Timing on a machine running a fleet of agents is noise, and
 * this repo has already been bitten by guards that pass for the wrong reason; the number of candidates
 * scanned IS the complexity, and it is deterministic.
 */
function candidatesScanned(g: SpatialGrid, x: number, y: number, reach: number): number {
  const cl = (v: number, len: number) => (v < 0 ? 0 : v >= len ? len - 1 : v | 0);
  const c0 = cl(Math.floor((x - reach - g.minX) / g.cellSize), g.cols);
  const c1 = cl(Math.floor((x + reach - g.minX) / g.cellSize), g.cols);
  const r0 = cl(Math.floor((y - reach - g.minY) / g.cellSize), g.rows);
  const r1 = cl(Math.floor((y + reach - g.minY) / g.cellSize), g.rows);
  let n = 0;
  for (let r = r0; r <= r1; r++) n += g.cellStart[r * g.cols + c1 + 1] - g.cellStart[r * g.cols + c0];
  return n;
}

describe("buildGrid", () => {
  it("indexes every node exactly once", () => {
    const xy = uniform(1000, 500);
    const g = buildGrid(xy, 1000);
    expect(g.count).toBe(1000);
    expect(g.items.length).toBe(1000);
    expect(new Set(g.items).size).toBe(1000);
    expect(g.cellStart[g.cellStart.length - 1]).toBe(1000);
  });

  it("survives an empty input rather than throwing on the render path", () => {
    const g = buildGrid(new Float32Array(0), 0);
    expect(g.count).toBe(0);
    expect(pickNearest(g, new Float32Array(0), 5, 0, 0, 10)).toBe(-1);
    expect(queryRect(g, 0, 0, 100, 100, new Uint32Array(8))).toBe(0);
  });

  it("handles every node sharing one position — a degenerate span is one cell, not a divide-by-zero", () => {
    const xy = new Float32Array(20).fill(7);
    const g = buildGrid(xy, 10);
    expect(g.count).toBe(10);
    expect(Number.isFinite(g.cellSize)).toBe(true);
    expect(g.cellSize).toBeGreaterThan(0);
    expect(pickNearest(g, xy, 1, 7, 7, 1)).toBeGreaterThanOrEqual(0);
  });

  it("CLAMPS a non-finite coordinate instead of dropping the node", () => {
    // A node you can see but cannot click is worse than one drawn at the edge, so NaN must still be
    // indexed. Dropping it from `items` is the failure this guards.
    const xy = new Float32Array([0, 0, 10, 10, NaN, 5, 20, 20]);
    const g = buildGrid(xy, 4);
    expect(g.items.length).toBe(4);
    expect(new Set(g.items).size).toBe(4);
  });

  it("caps the grid so one far outlier cannot ask for a hostile allocation", () => {
    // 500 clustered nodes and one a million units away. An uncapped grid sizes its cell to the CLUSTER
    // and its extent to the OUTLIER, which is how you ask for billions of cells.
    const xy = new Float32Array(501 * 2);
    for (let i = 0; i < 500; i++) { xy[i * 2] = i % 25; xy[i * 2 + 1] = Math.floor(i / 25); }
    xy[1000] = 1e6; xy[1001] = 1e6;
    const g = buildGrid(xy, 501);
    expect(g.cols * g.rows).toBeLessThanOrEqual(1 << 22);
    expect(g.items.length).toBe(501);
  });
});

describe("queryRect", () => {
  it("reports the nodes inside the rect and none from far outside it", () => {
    const xy = new Float32Array([0, 0, 10, 10, 100, 100, 105, 95, 500, 500]);
    const g = buildGrid(xy, 5);
    const out = new Uint32Array(16);
    const n = queryRect(g, 90, 85, 30, 30, out);
    const got = new Set([...out.slice(0, n)]);
    expect(got.has(2)).toBe(true);
    expect(got.has(3)).toBe(true);
    expect(got.has(4)).toBe(false);
  });

  it("TRUNCATES rather than allocating when `out` is too small, and says how many it wrote", () => {
    // The render path cannot budget for a surprise allocation; a short buffer must degrade, not grow.
    const xy = uniform(400, 50);
    const g = buildGrid(xy, 400);
    const out = new Uint32Array(7);
    const n = queryRect(g, -10, -10, 200, 200, out);
    expect(n).toBe(7);
    expect(out.every((v) => v < 400)).toBe(true);
  });

  it("finds everything when the rect covers the world", () => {
    const xy = uniform(300, 200, 9);
    const g = buildGrid(xy, 300);
    const out = new Uint32Array(512);
    expect(queryRect(g, -1000, -1000, 4000, 4000, out)).toBe(300);
  });
});

describe("pickNearest", () => {
  it("returns the nearest node whose own radius contains the point", () => {
    const xy = new Float32Array([0, 0, 30, 0, 60, 0]);
    const g = buildGrid(xy, 3);
    expect(pickNearest(g, xy, 10, 2, 0, 10)).toBe(0);
    expect(pickNearest(g, xy, 10, 29, 0, 10)).toBe(1);
  });

  it("returns -1 when the point is inside no node's radius", () => {
    const xy = new Float32Array([0, 0, 100, 100]);
    const g = buildGrid(xy, 2);
    expect(pickNearest(g, xy, 5, 50, 50, 60)).toBe(-1);
  });

  it("lets a LARGE node win over a nearer small one — the thing that makes clicking feel right", () => {
    // Node 1 is closer to the cursor but the cursor is outside it; node 0 is further but contains it.
    const xy = new Float32Array([0, 0, 24, 0]);
    const radii = new Float32Array([40, 2]);
    const g = buildGrid(xy, 2);
    expect(pickNearest(g, xy, radii, 20, 0, 40)).toBe(0);
  });

  it("agrees with a brute-force scan over a random field", () => {
    const n = 2000;
    const xy = uniform(n, 400, 42);
    const g = buildGrid(xy, n);
    const r = rng(7);
    for (let t = 0; t < 200; t++) {
      const px = r() * 400, py = r() * 400, rad = 6;
      let want = -1, bestD2 = Infinity;
      for (let i = 0; i < n; i++) {
        const dx = xy[i * 2] - px, dy = xy[i * 2 + 1] - py;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2 && d2 <= rad * rad) { bestD2 = d2; want = i; }
      }
      expect(pickNearest(g, xy, rad, px, py, rad)).toBe(want);
    }
  });
});

describe("the complexity guarantee", () => {
  it("keeps mean cell occupancy constant as the graph grows — the whole basis of O(1) lookup", () => {
    for (const n of [1_000, 50_000, 400_000]) {
      // Density held constant: extent grows as sqrt(n) so nodes-per-unit-area does not change.
      const g = buildGrid(uniform(n, Math.sqrt(n) * 20, 3), n);
      const mean = g.count / (g.cols * g.rows);
      expect(mean).toBeGreaterThan(0.5);
      expect(mean).toBeLessThan(8);
    }
  });

  it("does NOT degrade toward linear: candidates scanned per pick stays flat from 10k to 500k", () => {
    // The claim under test is that `pickNearest` is O(1) EXPECTED, not O(n). If the index ever regresses
    // to a scan, `scanned` tracks `n` and this fails loudly instead of the app just getting slower.
    const sample = (n: number): number => {
      const extent = Math.sqrt(n) * 20;
      const g = buildGrid(uniform(n, extent, 11), n);
      const r = rng(5);
      let worst = 0;
      for (let t = 0; t < 100; t++) {
        worst = Math.max(worst, candidatesScanned(g, r() * extent, r() * extent, g.cellSize));
      }
      return worst;
    };
    const small = sample(10_000);
    const large = sample(500_000);
    // 50× the nodes. A linear index would scan ~50× more; a constant-time one scans the same handful.
    expect(large).toBeLessThan(small * 3 + 20);
    expect(large).toBeLessThan(200);
  });
});
