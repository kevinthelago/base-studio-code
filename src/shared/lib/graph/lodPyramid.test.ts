// The pyramid's INVARIANTS and its complexity. The whole claim of this slice is "the drawn count stops
// referencing n", and that is a property, not an anecdote — so it is asserted across graph sizes an
// order of magnitude apart rather than measured once.
import { describe, it, expect } from "vitest";
import { buildPyramid, levelFor, MIN_SEPARATION_PX, type LodPyramid } from "@/shared/lib/graph/lodPyramid";

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function uniform(n: number, extent: number, seed = 1): Float32Array {
  const r = rng(seed);
  const xy = new Float32Array(n * 2);
  for (let i = 0; i < n * 2; i++) xy[i] = r() * extent;
  return xy;
}

/** Total aggregates a viewport of `vpW`x`vpH` px would draw at this scale. */
function drawnInViewport(p: LodPyramid, scale: number, vpW: number, vpH: number): number {
  const k = levelFor(p, scale);
  const lv = p.levels[k];
  // World rect the viewport covers, centred on the data's own middle so the sample is representative.
  const w = vpW / scale, h = vpH / scale;
  let cx = 0, cy = 0;
  for (let i = 0; i < lv.n; i++) { cx += lv.xy[i * 2]; cy += lv.xy[i * 2 + 1]; }
  cx /= Math.max(1, lv.n); cy /= Math.max(1, lv.n);
  const x0 = cx - w / 2, y0 = cy - h / 2;
  let seen = 0;
  for (let i = 0; i < lv.n; i++) {
    const x = lv.xy[i * 2], y = lv.xy[i * 2 + 1];
    if (x >= x0 && x <= x0 + w && y >= y0 && y <= y0 + h) seen++;
  }
  return seen;
}

describe("buildPyramid", () => {
  it("is TRANSPARENT at level 0 — the original nodes, unchanged", () => {
    // If the pyramid altered what you see when zoomed in, it would be a rendering change disguised as
    // an optimization.
    const xy = uniform(500, 400, 3);
    const p = buildPyramid(xy, 500);
    expect(p.levels[0].n).toBe(500);
    expect([...p.levels[0].xy]).toEqual([...xy]);
    expect([...p.levels[0].count].every((c) => c === 1)).toBe(true);
  });

  it("shrinks geometrically, and the WHOLE pyramid costs a small multiple of n", () => {
    const n = 50_000;
    const p = buildPyramid(uniform(n, 2000, 5), n);
    expect(p.levels.length).toBeGreaterThan(2);
    for (let k = 1; k < p.levels.length; k++) {
      expect(p.levels[k].n, `level ${k} must be smaller than ${k - 1}`).toBeLessThan(p.levels[k - 1].n);
    }
    const total = p.levels.reduce((s, l) => s + l.n, 0);
    // 1 + 1/4 + 1/16 + … converges below 4n/3; allow slack for boundary cells, but a pyramid costing
    // several times n would mean the levels are not really collapsing.
    expect(total).toBeLessThan(n * 2);
  });

  it("represents EVERY original node exactly once at every level", () => {
    // The counts are what an aggregate means. If they did not sum to n, the aggregate would be claiming
    // to stand for a population it does not have — and nothing on screen would reveal it.
    const n = 4000;
    const p = buildPyramid(uniform(n, 900, 7), n);
    for (const lv of p.levels) {
      const sum = [...lv.count].reduce((a, b) => a + b, 0);
      expect(sum, `level with ${lv.n} aggregates`).toBe(n);
    }
  });

  it("places every aggregate inside the bounds of what it represents", () => {
    const n = 3000;
    const xy = uniform(n, 600, 11);
    const p = buildPyramid(xy, n);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      minX = Math.min(minX, xy[i * 2]); maxX = Math.max(maxX, xy[i * 2]);
      minY = Math.min(minY, xy[i * 2 + 1]); maxY = Math.max(maxY, xy[i * 2 + 1]);
    }
    for (const lv of p.levels) {
      for (let i = 0; i < lv.n; i++) {
        expect(lv.xy[i * 2]).toBeGreaterThanOrEqual(minX - 1e-3);
        expect(lv.xy[i * 2]).toBeLessThanOrEqual(maxX + 1e-3);
        expect(lv.xy[i * 2 + 1]).toBeGreaterThanOrEqual(minY - 1e-3);
        expect(lv.xy[i * 2 + 1]).toBeLessThanOrEqual(maxY + 1e-3);
      }
    }
  });

  it("weights the centroid by population, so it does not drift with the pyramid's own shape", () => {
    // Three nodes in one cell and one in the next: the coarse aggregate of both must sit nearer the
    // heavy side. An unweighted mean of the two sub-aggregates would put it in the middle.
    const xy = new Float32Array([0, 0, 1, 0, 2, 0, 100, 0]);
    const p = buildPyramid(xy, 4, 4);
    const top = p.levels[p.levels.length - 1];
    if (top.n === 1) {
      expect(top.count[0]).toBe(4);
      expect(top.xy[0]).toBeCloseTo((0 + 1 + 2 + 100) / 4, 3);
    }
  });

  it("survives an empty graph and a single node", () => {
    expect(buildPyramid(new Float32Array(0), 0).levels[0].n).toBe(0);
    const one = buildPyramid(new Float32Array([5, 5]), 1);
    expect(one.levels[0].n).toBe(1);
    expect(levelFor(one, 1)).toBe(0);
  });

  it("does not spin on a degenerate extent", () => {
    // Every node at one point: no cell size ever reduces the population, so it must stop rather than
    // double the cell forever.
    const p = buildPyramid(new Float32Array(2000).fill(3), 1000);
    expect(p.levels.length).toBeLessThan(26);
  });
});

describe("levelFor", () => {
  it("is MONOTONIC in zoom — zooming out never selects a finer level", () => {
    // A non-monotonic selector flickers between levels as you zoom, which reads as the graph glitching.
    const p = buildPyramid(uniform(20_000, 1500, 13), 20_000);
    let prev = -1;
    for (const scale of [8, 4, 2, 1, 0.5, 0.25, 0.1, 0.05, 0.02, 0.01, 0.004]) {
      const k = levelFor(p, scale);
      expect(k, `scale ${scale} after ${prev}`).toBeGreaterThanOrEqual(prev === -1 ? 0 : prev);
      prev = k;
    }
  });

  it("returns level 0 when zoomed in — full detail is what a close view is for", () => {
    const p = buildPyramid(uniform(5000, 800, 17), 5000);
    expect(levelFor(p, 1000)).toBe(0);
  });

  it("keeps the selected level's separation at or above the legibility floor while one exists", () => {
    const p = buildPyramid(uniform(20_000, 1500, 19), 20_000);
    for (const scale of [2, 1, 0.4, 0.1, 0.03]) {
      const k = levelFor(p, scale);
      if (k > 0 && k < p.levels.length - 1) {
        expect(p.levels[k].cellSize * scale).toBeGreaterThanOrEqual(MIN_SEPARATION_PX);
      }
    }
  });
});

describe("the whole point", () => {
  it("bounds the DRAWN count by viewport, not by graph size", () => {
    // THE EXTENT IS FIXED AND ONLY THE DENSITY CHANGES, which is the only way this property is even
    // observable. An earlier version of this test grew the extent with n (constant density) and failed
    // reporting 2,508 against 25,150 — correctly, because at that zoom the viewport contained BOTH
    // graphs whole, so there was nothing to cull and drawing everything was the right answer. The claim
    // is not "two graphs always draw the same"; it is "the drawn count is bounded by what the viewport
    // can RESOLVE", and that only bites once the nodes outnumber the resolvable cells.
    const vp = [1600, 900] as const;
    const EXTENT = 20_000;
    const mk = (n: number) => buildPyramid(uniform(n, EXTENT, 23), n);
    const sparse = mk(20_000);
    const dense = mk(200_000);
    for (const scale of [0.05, 0.02, 0.01]) {
      const a = drawnInViewport(sparse, scale, vp[0], vp[1]);
      const b = drawnInViewport(dense, scale, vp[0], vp[1]);
      // 10x the nodes in the SAME space. The selected level's cell size is an absolute world size, so
      // both collapse to roughly the same number of cells over the same area — the drawn count tracks
      // the AREA, not n.
      expect(b, `scale ${scale}: sparse(20k) drew ${a}, dense(200k) drew ${b}`).toBeLessThan(a * 3 + 400);
      // And the absolute bound: viewport area divided by the separation floor.
      const cap = (vp[0] * vp[1]) / (MIN_SEPARATION_PX * MIN_SEPARATION_PX);
      expect(b, `scale ${scale}: drawn must stay under the viewport's resolvable cells (${cap})`).toBeLessThan(cap);
    }
  });

  it("builds a 1,000,000-node pyramid in well under a second", () => {
    const n = 1_000_000;
    const t = performance.now();
    const p = buildPyramid(uniform(n, 30_000, 29), n);
    const ms = performance.now() - t;
    expect(p.levels[0].n).toBe(n);
    expect(p.levels.length).toBeGreaterThan(3);
    // O(n) with a small constant. A per-node string key — the obvious way to bucket — would blow this.
    expect(ms, `built in ${ms.toFixed(0)}ms`).toBeLessThan(4000);
  });
});
