// The atlas's PURE halves: packing and pen layout. Rasterization needs a real 2D context and lives in
// `e2e/` — jsdom has no text rasterization at all, so a unit test of `buildGlyphAtlas` could only ever
// assert that a mock was called.
import { describe, it, expect } from "vitest";
import { packShelves, layoutLabel, DEFAULT_CHARSET, type Box, type GlyphAtlas, type Glyph } from "@/shared/lib/graph/glyphAtlas";

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const overlaps = (a: { x: number; y: number } & Box, b: { x: number; y: number } & Box): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("packShelves", () => {
  it("places every box, without overlap, inside the reported bounds", () => {
    // The three properties that matter, together: a packer that drops a glyph renders a label with a
    // hole, one that overlaps renders two glyphs on top of each other, and one that lies about its
    // bounds writes outside the texture.
    for (let seed = 1; seed <= 10; seed++) {
      const r = rng(seed);
      const boxes: Box[] = Array.from({ length: 60 }, () => ({ w: 4 + Math.floor(r() * 40), h: 4 + Math.floor(r() * 30) }));
      const res = packShelves(boxes, 256);
      expect(res).not.toBeNull();
      const { placed, width, height } = res!;
      expect(placed.length).toBe(boxes.length);
      const rects = placed.map((p, i) => ({ ...p, ...boxes[i] }));
      for (const rc of rects) {
        expect(rc.x).toBeGreaterThanOrEqual(0);
        expect(rc.y).toBeGreaterThanOrEqual(0);
        expect(rc.x + rc.w).toBeLessThanOrEqual(width);
        expect(rc.y + rc.h).toBeLessThanOrEqual(height);
      }
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          expect(overlaps(rects[i], rects[j]), `seed ${seed}: box ${i} overlaps ${j}`).toBe(false);
        }
      }
    }
  });

  it("returns positions in the CALLER's order, not the sorted one", () => {
    // It packs tallest-first internally. If it returned the sorted order, every glyph would be given
    // another glyph's rect — an atlas that looks plausible and renders the wrong letters.
    const boxes: Box[] = [{ w: 10, h: 5 }, { w: 10, h: 50 }, { w: 10, h: 20 }];
    const { placed } = packShelves(boxes, 100)!;
    // The tallest box opens the first shelf at y=0; the caller's index 1 must be the one at y=0.
    expect(placed[1].y).toBe(0);
    expect(placed.length).toBe(3);
  });

  it("REFUSES a box wider than the atlas rather than dropping it", () => {
    // Unfittable at any height. Silently skipping it is how a label ends up missing one character.
    expect(packShelves([{ w: 10, h: 10 }, { w: 300, h: 10 }], 256)).toBeNull();
  });

  it("opens a new shelf instead of overflowing the width", () => {
    const boxes: Box[] = [{ w: 60, h: 10 }, { w: 60, h: 10 }, { w: 60, h: 10 }];
    const res = packShelves(boxes, 100)!;
    expect(res.width).toBeLessThanOrEqual(100);
    expect(res.height).toBeGreaterThanOrEqual(20);
  });

  it("handles an empty set without producing a zero-sized texture", () => {
    const res = packShelves([], 128)!;
    expect(res.width).toBeGreaterThan(0);
    expect(res.height).toBeGreaterThan(0);
  });
});

/** A minimal atlas: 'a' and 'b' inked, space blank. */
function fakeAtlas(): GlyphAtlas {
  const g = (o: Partial<Glyph>): Glyph => ({ x: 0, y: 0, w: 10, h: 10, bearingX: 0, bearingY: -10, advance: 12, ...o });
  return {
    width: 32, height: 32, data: new Uint8Array(32 * 32), fontSize: 48, spread: 8, lineHeight: 60,
    glyphs: new Map<string, Glyph>([
      ["a", g({})],
      ["b", g({ advance: 20 })],
      [" ", g({ w: 0, h: 0, advance: 7 })],
    ]),
  };
}

describe("layoutLabel", () => {
  it("advances the pen by each glyph's own advance", () => {
    const { glyphs, width } = layoutLabel("ab", fakeAtlas());
    expect(glyphs.map((p) => p.x)).toEqual([0, 12]);
    expect(width).toBe(32);
  });

  it("emits no quad for a blank glyph but still advances", () => {
    // A space costs a vertex fetch and a discarded fragment for nothing — per space, per label, every
    // frame. At a few thousand visible labels that is real.
    const { glyphs, width } = layoutLabel("a b", fakeAtlas());
    expect(glyphs.length).toBe(2);
    expect(width).toBe(12 + 7 + 20); // a=12, space=7, b=20 — b advances 20 in the fixture
  });

  it("leaves a GAP for an unknown character rather than re-flowing the label", () => {
    // A label that silently shifts when it meets an unusual character is worse than one with a hole:
    // the hole is visible, the shift is not.
    const { glyphs, width } = layoutLabel("aéb", fakeAtlas());
    expect(glyphs.length).toBe(2);
    expect(glyphs[1].x).toBe(12 + 7);
    expect(width).toBe(12 + 7 + 20);
  });

  it("is empty for an empty string, not undefined", () => {
    expect(layoutLabel("", fakeAtlas())).toEqual({ glyphs: [], width: 0 });
  });
});

describe("DEFAULT_CHARSET", () => {
  it("covers printable ASCII — what component names and ids are actually made of", () => {
    expect(DEFAULT_CHARSET.length).toBe(95);
    for (const ch of ["a", "Z", "0", "-", "_", "/", " ", "~"]) {
      expect(DEFAULT_CHARSET.includes(ch), `charset is missing ${JSON.stringify(ch)}`).toBe(true);
    }
  });
});
