// A signed-distance glyph atlas, built at runtime from the app's own font
// (`gpu-graph-slice-2-labels`).
//
// BUILT AT RUNTIME, NOT AT BUILD TIME. The usual MSDF pipeline needs `msdfgen` and a checked-in
// artifact, which means new build tooling and a font file that drifts from whatever the theme actually
// resolves. This rasterizes through Canvas2D — so the atlas is always the font the user is really
// looking at — and turns the coverage into a distance field with the exact transform in `sdf.ts`.
//
// The cost is paid ONCE per (font, size): ~96 glyphs at a 72px cell is ~500k pixels through a linear
// transform. Per frame the atlas is a texture binding and nothing else.
//
// SPLIT ON PURPOSE. `packShelves` and `layoutLabel` are pure arithmetic and carry the properties worth
// asserting (nothing overlaps, nothing is silently dropped, pen advances match the metrics), so they
// are unit-testable with no canvas. `buildGlyphAtlas` needs a real 2D context and is covered in `e2e/`.

import { signedDistanceField } from "@/shared/lib/graph/sdf";

/** Where one glyph lives in the atlas, and how to place it on a pen line. All units are atlas pixels. */
export interface Glyph {
  /** Atlas rect. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Offset from the pen origin (on the baseline) to the quad's top-left. */
  bearingX: number;
  bearingY: number;
  /** How far the pen moves after drawing this glyph. */
  advance: number;
}

export interface GlyphAtlas {
  width: number;
  height: number;
  /** One byte per pixel — the signed distance, 128 at the outline. Upload as `R8`. */
  data: Uint8Array;
  glyphs: Map<string, Glyph>;
  /** The em size everything above is relative to. A label at any other size scales by `size/fontSize`. */
  fontSize: number;
  /** Distance-field spread in pixels; the shader needs it to convert a texel to a screen distance. */
  spread: number;
  lineHeight: number;
}

export interface Box {
  w: number;
  h: number;
}
export interface Placed {
  x: number;
  y: number;
}

/**
 * Shelf-pack boxes into a texture at most `maxWidth` wide — `O(g log g)`, dominated by the sort.
 *
 * Rows ("shelves") are opened as needed and each is as tall as its first (tallest) box, which is why
 * the boxes are placed tallest-first: a shelf opened by a short box wastes its whole height on the
 * next tall one. Good enough for a glyph set, where the heights are all within a factor of two —
 * a skyline packer would win a few percent and cost far more code to be right.
 *
 * Returns positions in the CALLER'S order, not the sorted one. Returns `null` when a single box is
 * wider than `maxWidth`, because that is unfittable at any height — the caller must widen the atlas,
 * and silently dropping the glyph would render a label with a hole in it.
 */
export function packShelves(boxes: readonly Box[], maxWidth: number): { placed: Placed[]; width: number; height: number } | null {
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[b].h - boxes[a].h || a - b);
  const placed: Placed[] = boxes.map(() => ({ x: 0, y: 0 }));
  let shelfY = 0;
  let shelfH = 0;
  let penX = 0;
  let widest = 0;
  for (const i of order) {
    const b = boxes[i];
    if (b.w > maxWidth) return null;
    if (penX + b.w > maxWidth) {
      shelfY += shelfH;
      shelfH = 0;
      penX = 0;
    }
    placed[i] = { x: penX, y: shelfY };
    penX += b.w;
    if (b.h > shelfH) shelfH = b.h;
    if (penX > widest) widest = penX;
  }
  return { placed, width: Math.max(1, widest), height: Math.max(1, shelfY + shelfH) };
}

/** One glyph quad on a laid-out line, in pen-space pixels relative to the label origin. */
export interface PenGlyph {
  glyph: Glyph;
  x: number;
  y: number;
}

/**
 * Pen positions for a string — `O(chars)`.
 *
 * Characters with no glyph in the atlas are SKIPPED but still advance by the atlas's space width, so an
 * unexpected character leaves a gap rather than shifting the rest of the label. A label that silently
 * re-flows when it meets an unusual character is worse than one with a hole in it, because the hole is
 * visible and the shift is not.
 */
export function layoutLabel(text: string, atlas: GlyphAtlas): { glyphs: PenGlyph[]; width: number } {
  const out: PenGlyph[] = [];
  const fallbackAdvance = atlas.glyphs.get(" ")?.advance ?? atlas.fontSize * 0.3;
  let pen = 0;
  for (const ch of text) {
    const g = atlas.glyphs.get(ch);
    if (!g) {
      pen += fallbackAdvance;
      continue;
    }
    // A zero-area glyph (space) advances without emitting a quad — an empty instance would cost a
    // vertex fetch and a discarded fragment for nothing, per space, per label.
    if (g.w > 0 && g.h > 0) out.push({ glyph: g, x: pen + g.bearingX, y: g.bearingY });
    pen += g.advance;
  }
  return { glyphs: out, width: pen };
}

/** The printable ASCII range — what component names, ids and counts are actually made of. */
export const DEFAULT_CHARSET: string = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("");

export interface AtlasOpts {
  /** Em size to rasterize at. Bigger is crisper when zoomed and costs atlas area; 48 is the working value. */
  fontSize?: number;
  /** Field spread in pixels either side of the outline. */
  spread?: number;
  /** Max atlas width. */
  maxWidth?: number;
  charset?: string;
}

/**
 * Rasterize `charset` in `font` and build the distance-field atlas.
 *
 * Needs a real `CanvasRenderingContext2D`, so it is exercised in `e2e/` rather than jsdom — jsdom's
 * canvas has no text rasterization at all, and a mock would only assert that the mock was called.
 *
 * Returns `null` when a 2D context cannot be obtained, matching `createGraphRenderer`: the caller keeps
 * its DOM text path rather than rendering a graph of unlabelled boxes.
 */
export function buildGlyphAtlas(font: string, opts: AtlasOpts = {}): GlyphAtlas | null {
  const fontSize = opts.fontSize ?? 48;
  const spread = opts.spread ?? 8;
  const maxWidth = opts.maxWidth ?? 1024;
  const charset = opts.charset ?? DEFAULT_CHARSET;

  const pad = Math.ceil(spread) + 2;
  const canvas = document.createElement("canvas");
  // One reusable cell, cleared per glyph: allocating a canvas per character would be ~95 GPU-backed
  // surfaces created and dropped in a row, which some drivers handle badly.
  const cell = Math.ceil(fontSize * 2) + pad * 2;
  canvas.width = cell;
  canvas.height = cell;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.font = `${fontSize}px ${font}`;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#fff";

  const chars = [...charset];
  const fields: { ch: string; sdf: Uint8Array; w: number; h: number; bearingX: number; bearingY: number; advance: number }[] = [];
  for (const ch of chars) {
    const m = ctx.measureText(ch);
    const advance = m.width;
    // `actualBoundingBox*` gives the INKED extent, which is what must be padded and packed — using the
    // advance width instead wastes atlas on the side bearings of every glyph and clips the ones that
    // overhang (an italic 'f', a 'j' tail).
    const left = Math.floor(m.actualBoundingBoxLeft ?? 0);
    const right = Math.ceil(m.actualBoundingBoxRight ?? advance);
    const asc = Math.ceil(m.actualBoundingBoxAscent ?? fontSize);
    const desc = Math.ceil(m.actualBoundingBoxDescent ?? 0);
    const iw = Math.max(0, right + left);
    const ih = Math.max(0, asc + desc);
    if (iw === 0 || ih === 0) {
      fields.push({ ch, sdf: new Uint8Array(0), w: 0, h: 0, bearingX: 0, bearingY: 0, advance });
      continue;
    }
    const w = iw + pad * 2;
    const h = ih + pad * 2;
    ctx.clearRect(0, 0, cell, cell);
    ctx.fillText(ch, pad + left, pad + asc);
    const img = ctx.getImageData(0, 0, Math.min(w, cell), Math.min(h, cell));
    const alpha = new Uint8Array(w * h);
    for (let y = 0; y < Math.min(h, img.height); y++) {
      for (let x = 0; x < Math.min(w, img.width); x++) {
        alpha[y * w + x] = img.data[(y * img.width + x) * 4 + 3];
      }
    }
    fields.push({
      ch,
      sdf: signedDistanceField(alpha, w, h, spread),
      w,
      h,
      bearingX: -left - pad,
      bearingY: -asc - pad,
      advance,
    });
  }

  const packed = packShelves(fields.map((f) => ({ w: f.w, h: f.h })), maxWidth);
  if (!packed) return null;
  const data = new Uint8Array(packed.width * packed.height);
  const glyphs = new Map<string, Glyph>();
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const p = packed.placed[i];
    for (let y = 0; y < f.h; y++) {
      data.set(f.sdf.subarray(y * f.w, y * f.w + f.w), (p.y + y) * packed.width + p.x);
    }
    glyphs.set(f.ch, { x: p.x, y: p.y, w: f.w, h: f.h, bearingX: f.bearingX, bearingY: f.bearingY, advance: f.advance });
  }
  return { width: packed.width, height: packed.height, data, glyphs, fontSize, spread, lineHeight: fontSize * 1.25 };
}
