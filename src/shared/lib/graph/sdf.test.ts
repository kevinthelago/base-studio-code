// The distance transform's EXACTNESS, checked against brute force.
//
// This is the assertion that matters. An approximate transform (chamfer, 8SSEDT) is a few percent
// wrong on diagonals and produces a field that looks entirely plausible — the error only shows as a
// faint wobble on glyph shoulders when you zoom in, which nobody would ever trace back to here. So the
// test compares against the definition — the nearest inside pixel, found by looking at all of them —
// rather than against a fixture that would encode whatever the implementation happened to do.
import { describe, it, expect } from "vitest";
import { edt2d, signedDistanceField } from "@/shared/lib/graph/sdf";

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** The definition: squared distance to the nearest set pixel, by exhaustive search. O(n^2) and correct. */
function bruteForce(inside: Uint8Array, w: number, h: number): Float64Array {
  const out = new Float64Array(w * h);
  const set: number[] = [];
  for (let i = 0; i < w * h; i++) if (inside[i]) set.push(i);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let best = Infinity;
      for (const i of set) {
        const dx = (i % w) - x;
        const dy = Math.floor(i / w) - y;
        const d = dx * dx + dy * dy;
        if (d < best) best = d;
      }
      out[y * w + x] = best;
    }
  }
  return out;
}

describe("edt2d", () => {
  it("matches a brute-force nearest-pixel search on random bitmaps", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const r = rng(seed);
      const w = 17 + (seed % 7);
      const h = 13 + (seed % 5);
      const inside = new Uint8Array(w * h);
      let any = false;
      for (let i = 0; i < w * h; i++) {
        inside[i] = r() < 0.18 ? 1 : 0;
        if (inside[i]) any = true;
      }
      if (!any) inside[0] = 1;
      const got = edt2d(inside, w, h);
      const want = bruteForce(inside, w, h);
      for (let i = 0; i < w * h; i++) {
        expect(got[i], `seed ${seed}, pixel ${i} (${i % w},${Math.floor(i / w)})`).toBeCloseTo(want[i], 6);
      }
    }
  });

  it("is exact on the DIAGONAL case an approximate transform gets wrong", () => {
    // A single set pixel in the corner. A chamfer transform accumulates error along the diagonal and
    // reports something near 1.41*n; the true squared distance is 2*n*n exactly.
    const w = 12, h = 12;
    const inside = new Uint8Array(w * h);
    inside[0] = 1;
    const d = edt2d(inside, w, h);
    for (let k = 0; k < 12; k++) {
      expect(d[k * w + k], `diagonal step ${k}`).toBeCloseTo(2 * k * k, 9);
    }
  });

  it("is zero everywhere when every pixel is inside", () => {
    const inside = new Uint8Array(6 * 6).fill(1);
    expect([...edt2d(inside, 6, 6)].every((v) => v === 0)).toBe(true);
  });

  it("does not crash on an empty bitmap — it reports 'unreachably far', not NaN", () => {
    // A glyph with no coverage (a space) is a real input, and NaN here would poison the whole atlas.
    const d = edt2d(new Uint8Array(5 * 5), 5, 5);
    expect([...d].every((v) => Number.isFinite(v) && v > 1e10)).toBe(true);
  });
});

describe("signedDistanceField", () => {
  it("puts the edge at 128, inside above it and outside below", () => {
    // The convention the shader depends on: sample > 0.5 means inside. Getting this backwards renders
    // every glyph as its own negative, which is obvious on screen and impossible to misread here.
    const w = 16, h = 16;
    const alpha = new Uint8Array(w * h);
    for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) alpha[y * w + x] = 255;
    const sdf = signedDistanceField(alpha, w, h, 8);
    expect(sdf[8 * w + 8]).toBeGreaterThan(128); // deep inside
    expect(sdf[0]).toBeLessThan(128); // far outside
    // Just inside the boundary is close to the edge value, and above it.
    expect(sdf[4 * w + 4]).toBeGreaterThan(128);
    expect(sdf[4 * w + 4]).toBeLessThan(200);
  });

  it("uses the byte range symmetrically around the edge for a given spread", () => {
    const w = 32, h = 32;
    const alpha = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 16; x < w; x++) alpha[y * w + x] = 255;
    const sdf = signedDistanceField(alpha, w, h, 8);
    const row = 16 * w;
    // A half-plane edge at x=16: distance grows by one pixel per step, so the encoded value should
    // move by 255/(2*spread) per pixel. Checked as a difference so the exact rounding does not matter.
    const step = Math.abs(sdf[row + 16] - sdf[row + 17]);
    expect(step).toBeGreaterThan(255 / 16 - 3);
    expect(step).toBeLessThan(255 / 16 + 3);
  });

  it("saturates rather than wrapping far from the outline", () => {
    // A byte that wraps produces a bright ring in the middle of empty space — a texture artifact that
    // looks like a rendering bug anywhere except here.
    const w = 64, h = 8;
    const alpha = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) alpha[y * w] = 255;
    const sdf = signedDistanceField(alpha, w, h, 4);
    expect(sdf[w - 1]).toBe(0);
    expect([...sdf].every((v) => v >= 0 && v <= 255)).toBe(true);
  });
});
