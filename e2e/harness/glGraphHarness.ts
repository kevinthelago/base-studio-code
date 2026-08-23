// Harness for the GPU graph renderer (`gpu-graph-slice-1-renderer-core`).
//
// It exists because jsdom has NO WebGL at all, so every claim this renderer makes — that it links, that
// it draws without a GL error, that selection touches one byte — is invisible to vitest by construction.
// The pure half (grid build, viewport query, picking) IS unit-tested; this covers the half that needs a
// real context.
import { createGraphRenderer, NODE_SELECTED, type GraphRenderer } from "@/shared/lib/graph/glGraphRenderer";
import { buildGlyphAtlas } from "@/shared/lib/graph/glyphAtlas";
import { buildPyramid } from "@/shared/lib/graph/lodPyramid";

/** What a call-counting wrapper observed since the last `resetCounters()`. */
export interface GlCounters {
  bufferData: number;
  bufferSubData: number;
  bufferSubDataBytes: number;
  texImage2D: number;
  texSubImage2D: number;
  drawInstanced: number;
}

declare global {
  interface Window {
    __glGraphHarness?: {
      create(nodes: number, edges: number): { ok: boolean; renderer: string; nodeCount: number; edgeCount: number };
      draw(frames: number): number;
      glError(): number;
      pickCenterOfNode(i: number): number;
      select(i: number): void;
      move(i: number, x: number, y: number): void;
      counters(): GlCounters;
      buildAtlas(): { ok: boolean; width: number; height: number; glyphs: number; ms: number };
      labelEveryNode(): void;
      setScale(scale: number): void;
      glyphCount(): number;
      attachLod(): { levels: number; populations: number[]; buildMs: number };
      detachLod(): void;
      drawnAt(scale: number): { level: number; instances: number };
      resetCounters(): void;
      isSoftware(): boolean;
      drawnExtentOf(i: number): { w: number; h: number; ratio: number } | string;
      cardSample(): { centre: number[]; dot: number[]; edge: number[]; distinctColours: number } | string;
    };
  }
}

const counters: GlCounters = { bufferData: 0, bufferSubData: 0, bufferSubDataBytes: 0, texImage2D: 0, texSubImage2D: 0, drawInstanced: 0 };
let renderer: GraphRenderer | null = null;
let gl: WebGL2RenderingContext | null = null;
export const CARD_W = 172;
export const CARD_H = 58;
let positions = new Float32Array(0);
let sizes = new Float32Array(0);
let rendererName = "";

/** Deterministic — a harness that seeds from Math.random cannot be compared run to run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function instrument(ctx: WebGL2RenderingContext): void {
  const bd = ctx.bufferData.bind(ctx);
  const bsd = ctx.bufferSubData.bind(ctx);
  const ti = ctx.texImage2D.bind(ctx);
  const tsi = ctx.texSubImage2D.bind(ctx);
  const dai = ctx.drawArraysInstanced.bind(ctx);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ctx as any).bufferData = (...a: any[]) => { counters.bufferData++; return (bd as any)(...a); };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ctx as any).bufferSubData = (...a: any[]) => {
    counters.bufferSubData++;
    const src = a[2];
    if (src && typeof src.byteLength === "number") counters.bufferSubDataBytes += src.byteLength;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (bsd as any)(...a);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ctx as any).texImage2D = (...a: any[]) => { counters.texImage2D++; return (ti as any)(...a); };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ctx as any).texSubImage2D = (...a: any[]) => { counters.texSubImage2D++; return (tsi as any)(...a); };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ctx as any).drawArraysInstanced = (...a: any[]) => { counters.drawInstanced++; return (dai as any)(...a); };
}

window.__glGraphHarness = {
  create(nodes, edges) {
    const canvas = document.getElementById("gl") as HTMLCanvasElement;
    const probe = canvas.getContext("webgl2");
    if (!probe) return { ok: false, renderer: "none", nodeCount: 0, edgeCount: 0 };
    gl = probe;
    const dbg = probe.getExtension("WEBGL_debug_renderer_info");
    rendererName = String(dbg ? probe.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : probe.getParameter(probe.RENDERER));
    instrument(probe);

    // A grid layout, not a random cloud: it is what the layered DAG produces, it makes `pickCenterOfNode`
    // predictable, and a random cloud would let a broken index pass by luck.
    const cols = Math.max(1, Math.ceil(Math.sqrt(nodes)));
    positions = new Float32Array(nodes * 2);
    sizes = new Float32Array(nodes * 2);
    const rgba = new Uint32Array(nodes);
    for (let i = 0; i < nodes; i++) {
      positions[i * 2] = (i % cols) * 40;
      positions[i * 2 + 1] = Math.floor(i / cols) * 40;
      // RECTANGULAR on purpose — the shape the product actually draws (NODE_W x NODE_H = 172x58) and the
      // shape a square-drawing bug is invisible against.
      sizes[i * 2] = CARD_W;
      sizes[i * 2 + 1] = CARD_H;
      rgba[i] = 0xff000000 | (i * 2654435761) & 0x00ffffff;
    }
    const r = rng(7);
    const pairs = new Uint32Array(edges * 2);
    for (let e = 0; e < edges; e++) {
      pairs[e * 2] = Math.floor(r() * nodes);
      pairs[e * 2 + 1] = Math.floor(r() * nodes);
    }
    renderer = createGraphRenderer(canvas, { preserveDrawingBuffer: true });
    if (!renderer) return { ok: false, renderer: rendererName, nodeCount: 0, edgeCount: 0 };
    renderer.resize(1280, 800, 1);
    renderer.setNodes(positions, sizes, rgba, nodes);
    renderer.setEdges(pairs, edges);
    // Fit the whole grid so picking works in screen space without a separate transform to reason about.
    const worldW = cols * 40;
    const scale = 1280 / Math.max(worldW, 1);
    renderer.setView({ tx: 0, ty: 0, scale });
    return { ok: true, renderer: rendererName, nodeCount: renderer.nodeCount, edgeCount: renderer.edgeCount };
  },
  draw(frames) {
    if (!renderer || !gl) return -1;
    for (let i = 0; i < 3; i++) renderer.draw();
    gl.finish();
    const t = performance.now();
    for (let i = 0; i < frames; i++) renderer.draw();
    gl.finish();
    return (performance.now() - t) / frames;
  },
  glError() { return gl ? gl.getError() : -1; },
  pickCenterOfNode(i) {
    if (!renderer) return -2;
    // Feed pick the node's own centre transformed to screen space — the inverse of what the shader does,
    // so a disagreement between drawing and picking shows up here rather than as a mis-click in the app.
    const scale = 1280 / Math.max(Math.ceil(Math.sqrt(positions.length / 2)) * 40, 1);
    return renderer.pick(positions[i * 2] * scale, positions[i * 2 + 1] * scale);
  },
  select(i) { renderer?.setState(i, NODE_SELECTED); },
  move(i, x, y) { renderer?.setPosition(i, x, y); },
  buildAtlas() {
    const t = performance.now();
    const a = buildGlyphAtlas("system-ui, sans-serif", { fontSize: 40, spread: 6 });
    const ms = performance.now() - t;
    if (!a || !renderer) return { ok: false, width: 0, height: 0, glyphs: 0, ms };
    renderer.setAtlas(a);
    return { ok: true, width: a.width, height: a.height, glyphs: a.glyphs.size, ms };
  },
  labelEveryNode() {
    if (!renderer) return;
    // EVERY node gets a label — the adversarial case for the LOD gate. If the gate does not hold, this
    // is ~12M glyph quads.
    const n = renderer.nodeCount;
    const out: string[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = `node-${i}`;
    renderer.setLabels(out);
  },
  setScale(scale) {
    renderer?.setView({ tx: 0, ty: 0, scale });
  },
  glyphCount() { return renderer?.lastGlyphCount ?? -1; },
  attachLod() {
    if (!renderer) return { levels: 0, populations: [], buildMs: 0 };
    const t = performance.now();
    const p = buildPyramid(positions, renderer.nodeCount);
    const buildMs = performance.now() - t;
    renderer.setLod(p);
    return { levels: p.levels.length, populations: p.levels.map((l) => l.n), buildMs };
  },
  detachLod() { renderer?.setLod(null); },
  drawnAt(scale) {
    if (!renderer) return { level: -1, instances: -1 };
    renderer.setView({ tx: 0, ty: 0, scale });
    renderer.draw();
    // `nodeCount` is what the last upload put in the buffer, so it IS the instance count the draw used.
    return { level: renderer.lodLevel, instances: renderer.nodeCount };
  },
  counters() { return { ...counters }; },
  resetCounters() {
    counters.bufferData = 0; counters.bufferSubData = 0; counters.bufferSubDataBytes = 0;
    counters.texImage2D = 0; counters.texSubImage2D = 0; counters.drawInstanced = 0;
  },
  /**
   * Measure what the renderer actually DRAWS for one card, on its OWN canvas.
   *
   * Isolated deliberately. Measuring against the shared million-node fixture does not work — its grid
   * pitch is 40 px and the cards are 172 wide, so every node overlaps its neighbours and the lit bounding
   * box spans the whole screen. It also keeps the shared graph untouched for any test that follows.
   *
   * This is the check slice 5 never had: it counted lit PIXELS, which is equally true of a graph drawn
   * with every card three times too tall. Shape has to be measured, not presence of ink.
   */
  drawnExtentOf(_i) {
    const c = document.createElement("canvas");
    c.width = 512; c.height = 512;
    const r = createGraphRenderer(c, { preserveDrawingBuffer: true });
    if (!r) return "no renderer";
    const g2 = c.getContext("webgl2");
    if (!g2) return "no context";
    const xy = new Float32Array([0, 0]);
    const size = new Float32Array([CARD_W, CARD_H]);
    const rgba = new Uint32Array([0xffffffff]);
    r.resize(512, 512, 1);
    r.setNodes(xy, size, rgba, 1);
    r.setEdges(new Uint32Array(0), 0);
    r.setView({ tx: 256, ty: 256, scale: 1 });
    r.draw();
    const px = new Uint8Array(512 * 512 * 4);
    g2.readPixels(0, 0, 512, 512, g2.RGBA, g2.UNSIGNED_BYTE, px);
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9, lit = 0;
    for (let y = 0; y < 512; y++) {
      for (let x = 0; x < 512; x++) {
        if (px[(y * 512 + x) * 4 + 3] > 24) {
          lit++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    r.dispose();
    if (lit === 0) return "nothing drawn";
    const w = maxX - minX + 1, h = maxY - minY + 1;
    return { w, h, ratio: +(w / h).toFixed(2) };
  },
  /** Sample the drawn card at three places: its centre, the role dot, and its border. */
  cardSample() {
    const c = document.createElement("canvas");
    c.width = 512; c.height = 512;
    const r = createGraphRenderer(c, { preserveDrawingBuffer: true });
    if (!r) return "no renderer";
    const g2 = c.getContext("webgl2");
    if (!g2) return "no context";
    // A vivid role colour, so a filled card is unmistakable from a surface one.
    r.setPalette([0.11, 0.12, 0.14, 1], [0.35, 0.37, 0.40, 1], [0.36, 0.62, 1, 1]);
    r.resize(512, 512, 1);
    r.setNodes(new Float32Array([0, 0]), new Float32Array([CARD_W, CARD_H]), new Uint32Array([0xff00a0ff]), 1);
    r.setEdges(new Uint32Array(0), 0);
    r.setView({ tx: 256, ty: 256, scale: 1 });
    r.draw();
    const px = new Uint8Array(512 * 512 * 4);
    g2.readPixels(0, 0, 512, 512, g2.RGBA, g2.UNSIGNED_BYTE, px);
    // readPixels is bottom-up; the card is centred at (256,256).
    const at = (x: number, y: number) => {
      const i = ((511 - y) * 512 + x) * 4;
      return [px[i], px[i + 1], px[i + 2], px[i + 3]];
    };
    const left = 256 - CARD_W / 2, top = 256 - CARD_H / 2;
    const seen = new Set<string>();
    for (let y = top; y < top + CARD_H; y += 2) {
      for (let x = left; x < left + CARD_W; x += 2) {
        const p2 = at(Math.round(x), Math.round(y));
        if (p2[3] > 40) seen.add(p2.slice(0, 3).join(","));
      }
    }
    const out = {
      centre: at(256, 256),
      dot: at(Math.round(left + 17), Math.round(top + 19)),
      edge: at(Math.round(left + 1), 256),
      distinctColours: seen.size,
    };
    r.dispose();
    return out;
  },
  isSoftware() { return /swiftshader|llvmpipe|software|swrast/i.test(rendererName); },
};
