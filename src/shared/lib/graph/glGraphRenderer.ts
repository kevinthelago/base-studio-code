// The GPU graph renderer — instanced nodes + edges in two draw calls (`gpu-graph-slice-1-renderer-core`).
//
// WHY. The DOM graph costs ~19 µs per element per style/layout pass, linearly: 402 nodes ⇒ 99 ms,
// 8,002 ⇒ 1,051 ms, and one click on the 402-node Design Studio graph measured 371–506 ms. At ~6
// elements per node that is ~115 µs/node, so ten thousand nodes is a second of frozen UI and a million
// is two minutes — with the browser out of memory long before it gets there. No amount of trimming
// elements per node fixes an O(N) shape.
//
// Measured in this app's own WebKitGTK webview, one `drawArraysInstanced` at 1920×1080:
//
//     1M small quads (nodes)    1.55 ms   645 fps    11 MB VRAM
//     5M wide quads (edges)    13.2  ms    76 fps    57 MB
//    10M wide quads            22.2  ms    45 fps   114 MB
//
// So a million nodes is a TENTH of a frame budget and the interesting cost is edges, which go
// fill-bound between 5M and 10M. That asymmetry drives two decisions below.
//
// WEBGL2, AND IT MUST STAY WEBGL2. `navigator.gpu` is ABSENT in WebKitGTK — measured, not assumed — so
// there is no WebGPU path to migrate to. What is available and used here: instanced arrays, integer
// vertex attributes, and `texelFetch` on a float texture.
//
// NODES ARE NOT CPU-CULLED, deliberately. Culling them would mean an O(N) pass per frame on the main
// thread, which is precisely the cost this module exists to delete — and it would buy nothing, because
// the GPU clips off-screen geometry for free and the whole million-node draw is 1.55 ms. Edges are the
// ones worth culling, and that is the LOD slice, not this one.
//
// POSITIONS LIVE IN A TEXTURE, NOT AN ATTRIBUTE. Both nodes and edges need them, and an edge that stored
// its endpoints as floats would need rebuilding whenever a node moved — O(E) for a one-node change. With
// positions in an RG32F texture the edge buffer is just two indices, and moving a node is ONE
// `texSubImage2D` texel: O(1). It also halves edge memory (8 B/edge rather than 16 B).

import type { GraphView } from "@/shared/ui/layouts/useGraphViewport";
import { buildGrid, pickRect, queryRect, type SpatialGrid } from "@/shared/lib/graph/spatialGrid";
import { layoutLabel, type GlyphAtlas } from "@/shared/lib/graph/glyphAtlas";
import { levelFor, type LodPyramid } from "@/shared/lib/graph/lodPyramid";

/** Per-instance state byte. Drives appearance in the shader; never causes a re-upload of anything else. */
export const NODE_NORMAL = 0;
export const NODE_SELECTED = 1;
export const NODE_DIMMED = 2;

/** Width of the position texture. 2048 keeps it well inside every `MAX_TEXTURE_SIZE` we could meet
 *  (this webview reports 16384) while covering 1M nodes in 489 rows. */
const POS_TEX_W = 2048;

export interface GraphRenderer {
  /**
   * Upload node positions/sizes/colours. O(n); rebuilds the pick index. `rgba` is packed 0xAABBGGRR.
   *
   * `size` is INTERLEAVED `[w0,h0, w1,h1, …]`. It was a single scalar per node and that shipped every
   * card as a square — 172x58 drawn 172x172, swallowing the rows above and below.
   */
  setNodes(xy: Float32Array, size: Float32Array, rgba: Uint32Array, count: number): void;
  /** Upload edges as node-index PAIRS. O(e). Endpoints are read from the position texture at draw time. */
  setEdges(pairs: Uint32Array, count: number): void;
  /** Change one node's state byte. O(1) — one `bufferSubData` of a single byte. */
  setState(index: number, state: number): void;
  /** Move one node. O(1) — one texel. Keeps the pick index correct by marking it stale. */
  setPosition(index: number, x: number, y: number): void;
  /** Pan/zoom. O(1) — uniforms only, no geometry touched. */
  setView(view: GraphView): void;
  /** Match the drawing buffer to the CSS size × dpr. */
  resize(cssW: number, cssH: number, dpr?: number): void;
  /** Two instanced draw calls. O(1) CPU regardless of node count. */
  draw(): void;
  /** Node index under a CSS-pixel point, or -1. O(1) expected — a grid query, never a scan, and never
   *  `readPixels` (a GPU readback is a pipeline stall costing more than the query it would replace). */
  pick(cssX: number, cssY: number): number;
  /**
   * Attach an LOD pyramid. From here the renderer draws the level the zoom can actually resolve, so the
   * frame cost tracks VIEWPORT AREA rather than node count. Pass `null` to go back to drawing the nodes.
   */
  /**
   * The card palette as 0..1 RGBA. Resolve from the live cascade (--bg-elev, --border, --accent) rather
   * than hard-coding: a second copy of the palette is a second thing to keep in sync with the theme.
   */
  setPalette?(
    surface: readonly number[],
    border: readonly number[],
    accent: readonly number[],
    /** The label colour — `--fg`. Omitted by an older caller, which keeps the previous near-white. */
    text?: readonly number[],
  ): void;
  setLod(pyramid: LodPyramid | null, aggregateColor?: number): void;
  /** Which pyramid level the last `draw()` used. 0 means the nodes themselves. */
  readonly lodLevel: number;
  /** Upload the glyph atlas. Once per (font, size) — never per frame. */
  setAtlas(atlas: GlyphAtlas): void;
  /** Label text per node index. `null`/absent entries simply get no label. */
  setLabels(labels: readonly (string | null)[]): void;
  /** How many glyph instances the last `draw()` emitted — the bounded number, for tests and telemetry. */
  readonly lastGlyphCount: number;
  dispose(): void;
  readonly nodeCount: number;
  readonly edgeCount: number;
}

const NODE_VS = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in vec2 aSize;
layout(location=2) in vec4 aColor;
layout(location=3) in float aState;
uniform sampler2D uPos;
uniform vec2 uViewport;
uniform vec2 uTranslate;
uniform float uScale;
out vec2 vCorner; out vec4 vColor; out float vState; out float vPx; out vec2 vHalf; out float vShort;
void main() {
  ivec2 t = ivec2(gl_InstanceID % ${POS_TEX_W}, gl_InstanceID / ${POS_TEX_W});
  vec2 p = texelFetch(uPos, t, 0).rg;
  vec2 world = p + aCorner * (aSize * 0.5);
  vec2 s = world * uScale + uTranslate;
  gl_Position = vec4(s.x / uViewport.x * 2.0 - 1.0, 1.0 - s.y / uViewport.y * 2.0, 0.0, 1.0);
  vCorner = aCorner; vColor = aColor; vState = aState;
  // Half-extents in world units, normalised on the SHORT axis. The fragment shader evaluates the SDF in
  // this space so the corner radius stays CIRCULAR: evaluating it in raw (-1..1) corner space stretches
  // the radius with the aspect ratio and gives a 172x58 card lozenge ends.
  vHalf = aSize / min(aSize.x, aSize.y);
  // The short half-extent in WORLD units. The fragment shader measures the border, the dot and the
  // padding in world units (they are card geometry, not screen geometry), and this is the conversion.
  vShort = min(aSize.x, aSize.y) * 0.5;
  // The THIN axis sets the pixel gradient, so antialiasing must be derived from it — using the long axis
  // makes a wide, short card's edges soften as if it were three times taller than it is.
  vPx = min(aSize.x, aSize.y) * uScale;
}`;

// Rounded-rect SDF. Chosen over a plain quad because the cost is PER-PIXEL, not per-node — the shape is
// free at any count — and because it stays crisp at every zoom where a bitmap or a CSS border would not.
const NODE_FS = `#version 300 es
precision mediump float;
in vec2 vCorner; in vec4 vColor; in float vState; in float vPx; in vec2 vHalf; in float vShort;
out vec4 outColor;
uniform vec4 uSurface;
uniform vec4 uBorder;
uniform vec4 uAccent;
float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}
void main() {
  // vCorner is -1..1 on both axes; scaling by vHalf restores the real aspect, so the box is measured in
  // units of the SHORT half-extent and the radius is the same in x and y.
  vec2 p = vCorner * vHalf;
  // Card metrics, mirroring .ds-node in designStudio.css. Expressed as world units over the short
  // half-extent so they travel with the card's size instead of being pinned to one graph's numbers:
  //   border-radius 11px · border 1px · padding 11px 13px · an 8px role dot in the first grid column.
  float u = 1.0 / max(vShort, 0.0001);      // one world unit, in SDF space
  float d = sdRoundBox(p, vHalf, 11.0 * u);
  // One pixel in local units, so antialiasing is a constant screen width at any zoom.
  float aa = max(fwidth(d), 1.0 / max(vPx, 1.0));
  float card = 1.0 - smoothstep(-aa, aa, d);
  if (card <= 0.003) discard;

  float st = floor(vState * 255.0 + 0.5);
  // The BORDER carries the state, never the fill — .ds-node keeps its elevated surface when selected
  // (#2491), and painting the body would lose the role dot and the text contrast with it.
  vec4 border = uBorder;
  if (st == 1.0) border = uAccent;
  if (st == 3.0) border = mix(uBorder, uAccent, 0.55);

  // Inset by one world unit — the 1px border.
  float interior = 1.0 - smoothstep(-aa, aa, d + 1.0 * u);
  vec4 col = mix(border, uSurface, interior);

  // The role dot: 8px across, centred in the first grid column (padding-left 13 + radius 4) and on the
  // NAME row (padding-top 11 + half of that row). This is the only place the role colour appears — it
  // used to be the entire card, which is what made the graph read as coloured blobs.
  vec2 dotC = vec2(-vHalf.x + 17.0 * u, -vHalf.y + 19.0 * u);
  float dotD = length(p - dotC) - 4.0 * u;
  float dot = 1.0 - smoothstep(-aa, aa, dotD);
  col.rgb = mix(col.rgb, vColor.rgb, dot * vColor.a);

  // Dimmed: a related/background node loses contrast without losing its identity.
  float alpha = col.a;
  if (st == 2.0) { col.rgb = mix(col.rgb, uSurface.rgb, 0.45); alpha *= 0.55; }
  outColor = vec4(col.rgb * card * alpha, card * alpha);
}`;

const EDGE_VS = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in uvec2 aPair;
layout(location=2) in vec4 aColor;
uniform sampler2D uPos;
uniform vec2 uViewport;
uniform vec2 uTranslate;
uniform float uScale;
uniform float uWidthPx;
out vec4 vColor;
vec2 fetchPos(uint i) {
  return texelFetch(uPos, ivec2(int(i) % ${POS_TEX_W}, int(i) / ${POS_TEX_W}), 0).rg;
}
void main() {
  vec2 a = fetchPos(aPair.x) * uScale + uTranslate;
  vec2 b = fetchPos(aPair.y) * uScale + uTranslate;
  vec2 d = b - a;
  float len = length(d);
  // A zero-length edge (a self-loop, or two nodes not yet laid out) has no direction; normalizing it
  // yields NaN and the GPU renders a full-screen triangle of garbage. Fall back to a fixed axis.
  vec2 dir = len > 1e-6 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  // Width in SCREEN px, so lines stay legible when zoomed out instead of vanishing sub-pixel.
  vec2 s = mix(a, b, aCorner.x) + nrm * aCorner.y * uWidthPx;
  gl_Position = vec4(s.x / uViewport.x * 2.0 - 1.0, 1.0 - s.y / uViewport.y * 2.0, 0.0, 1.0);
  vColor = aColor;
}`;

const EDGE_FS = `#version 300 es
precision mediump float;
in vec4 vColor; out vec4 outColor;
void main() { outColor = vec4(vColor.rgb * vColor.a, vColor.a); }`;

// Labels are drawn as one instanced quad per GLYPH, positioned in SCREEN space. Screen space rather
// than world space because a label must stay the same size relative to its node while the graph zooms,
// and because the CPU is already visiting each visible node to decide whether it gets a label at all.
const LABEL_VS = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 aRect;
layout(location=2) in vec4 aUv;
uniform vec2 uViewport;
out vec2 vUv;
void main() {
  vec2 s = aRect.xy + aCorner * aRect.zw;
  gl_Position = vec4(s.x / uViewport.x * 2.0 - 1.0, 1.0 - s.y / uViewport.y * 2.0, 0.0, 1.0);
  vUv = mix(aUv.xy, aUv.zw, aCorner);
}`;

// `fwidth` of the sampled distance is the whole reason this is a distance field: it gives the width of
// one screen pixel IN FIELD UNITS, so the same texture antialiases correctly at any zoom instead of
// blurring in and aliasing out the way a bitmap atlas does.
const LABEL_FS = `#version 300 es
precision mediump float;
in vec2 vUv; out vec4 outColor;
uniform sampler2D uAtlas;
uniform vec4 uColor;
void main() {
  float d = texture(uAtlas, vUv).r;
  float aa = max(fwidth(d), 0.001);
  float a = smoothstep(0.5 - aa, 0.5 + aa, d);
  if (a <= 0.004) discard;
  outColor = vec4(uColor.rgb * uColor.a * a, uColor.a * a);
}`;

/**
 * Smallest label the eye can use, in screen px of em size.
 *
 * This is not a taste setting — it is what BOUNDS THE WORK. A glyph is emitted only for a node whose
 * label would clear this, so the number of labels is limited by screen area divided by legible size,
 * never by graph size. Without it a million nodes means ~12M glyph quads, which is both over the frame
 * budget (measured: 10M wide quads = 22.2 ms) and unreadable, which is the more important half.
 */
const MIN_LABEL_PX = 7;

/**
 * Hard cap on glyph instances per frame.
 *
 * The legibility gate already bounds this in every sane view; the cap covers the pathological one — a
 * layout that stacked every node at one point would pass the gate for all of them at once. Truncating
 * loses labels, which is visible and recoverable; not truncating stalls the frame.
 */
const MAX_LABEL_GLYPHS = 20000;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("createShader returned null");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) ?? "(no log)";
    gl.deleteShader(sh);
    throw new Error(`shader compile failed: ${log}`);
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  const p = gl.createProgram();
  if (!p) throw new Error("createProgram returned null");
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p) ?? "(no log)";
    gl.deleteProgram(p);
    throw new Error(`program link failed: ${log}`);
  }
  return p;
}

export interface GraphRendererOpts {
  /** Edge width in screen px. Default 1.5. */
  edgeWidthPx?: number;
  /** Edge colour, packed 0xAABBGGRR. Default a dim neutral. */
  edgeColor?: number;
  /**
   * Keep the drawing buffer after compositing so a caller can read the pixels back. OFF by default —
   * it costs a copy every frame and no product path needs it.
   *
   * It exists because verifying this renderer WITHOUT it is not possible: a composited WebGL buffer is
   * cleared before any later read, so `drawImage` reports an empty canvas for a graph that drew fine.
   * That false negative is how "the pixels are lit" became the whole of slice 5's visual verification —
   * and a graph drawn with every card three times too tall passes that check.
   */
  preserveDrawingBuffer?: boolean;
}

/**
 * Create a renderer over `canvas`, or `null` when WebGL2 is unavailable.
 *
 * NULL IS A CONTRACT, not a failure to log and forget: the caller is expected to keep its DOM path and
 * fall back to it. That fallback is also what preserves the accessibility tree, which a canvas does not
 * have — see the epic. A renderer that threw here would take the page down on exactly the machines least
 * able to afford it.
 */
export function createGraphRenderer(canvas: HTMLCanvasElement, opts: GraphRendererOpts = {}): GraphRenderer | null {
  const ctx = canvas.getContext("webgl2", {
    antialias: false, alpha: true, premultipliedAlpha: true, depth: false,
    preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false,
  });
  if (!ctx) return null;
  // Bound to its own non-nullable const: the closures below are FUNCTION DECLARATIONS, which hoist, so
  // TypeScript will not carry the `if (!ctx)` narrowing into them.
  const gl: WebGL2RenderingContext = ctx;

  const edgeWidthPx = opts.edgeWidthPx ?? 1.5;
  // The card palette. These defaults are a dark-surface guess; the caller resolves the REAL tokens
  // (--bg-elev, --border, --accent) from the live cascade, so the graph follows the theme instead of
  // carrying a second copy of it.
  let surfaceRgba: [number, number, number, number] = [0.11, 0.12, 0.14, 1];
  let borderRgba: [number, number, number, number] = [0.25, 0.27, 0.30, 1];
  let accentRgba: [number, number, number, number] = [0.36, 0.62, 1.0, 1];
  // The LABEL colour. It was a literal in the draw path — written when the card was drawn in the role
  // colour, where near-white read against anything. The card is the surface token now, so the text's
  // contrast against it was coincidence rather than a guarantee, and on a light theme it was
  // near-white on near-white. This is the last colour in the renderer that has to come from the theme.
  let textRgba: [number, number, number, number] = [0.93, 0.94, 0.96, 1];
  const edgeColor = opts.edgeColor ?? 0x66808080;

  let nodeProg: WebGLProgram, edgeProg: WebGLProgram, labelProg: WebGLProgram;
  try {
    nodeProg = link(gl, NODE_VS, NODE_FS);
    edgeProg = link(gl, EDGE_VS, EDGE_FS);
    labelProg = link(gl, LABEL_VS, LABEL_FS);
  } catch {
    // A driver that cannot compile these is a driver we fall back from, not one we crash on.
    return null;
  }

  // Unit quad, shared by both programs. Corner space is (-1..1) for nodes and (0..1, -0.5..0.5) for
  // edges, so each program reinterprets the same four vertices rather than owning a second buffer.
  const nodeQuad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
  const edgeQuad = new Float32Array([0, -0.5, 1, -0.5, 0, 0.5, 1, 0.5]);
  const nodeQuadBuf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, nodeQuadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, nodeQuad, gl.STATIC_DRAW);
  const edgeQuadBuf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, edgeQuadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, edgeQuad, gl.STATIC_DRAW);
  // Labels need a 0..1 corner: `aRect.xy` is the quad's top-left and the corner scales `aRect.zw` off
  // it. The node quad is -1..1 (centred) and the edge quad is 0..1 by 0.5 (a ribbon), so neither fits.
  const unitQuad = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
  const unitQuadBuf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, unitQuadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, unitQuad, gl.STATIC_DRAW);

  const sizeBuf = gl.createBuffer()!;
  const colorBuf = gl.createBuffer()!;
  const stateBuf = gl.createBuffer()!;
  const pairBuf = gl.createBuffer()!;
  const edgeColorBuf = gl.createBuffer()!;
  const posTex = gl.createTexture()!;
  const atlasTex = gl.createTexture()!;
  const labelRectBuf = gl.createBuffer()!;
  const labelUvBuf = gl.createBuffer()!;
  const nodeVao = gl.createVertexArray()!;
  const edgeVao = gl.createVertexArray()!;
  const labelVao = gl.createVertexArray()!;

  let nodeCount = 0;
  let edgeCount = 0;
  let posRows = 1;
  let stateBytes = new Uint8Array(0);
  // Annotated: an un-annotated `new Float32Array(0)` infers `Float32Array<ArrayBuffer>`, which refuses the
  // caller's `Float32Array` (ArrayBufferLike) under TS 5.7 typed-array generics.
  let positions: Float32Array = new Float32Array(0);
  let halfW = new Float32Array(0);
  let halfH = new Float32Array(0);
  /** The largest node radius, kept as the pick search reach. Computed ONCE per `setNodes`: deriving it
   *  inside `pick` was an O(n) scan on every mousemove, which would have quietly cost more than the
   *  index saves and made the O(1) claim false. */
  let maxRadius = 0;
  let grid: SpatialGrid | null = null;
  let gridStale = true;
  let view: GraphView = { tx: 0, ty: 0, scale: 1 };
  let vpW = 1, vpH = 1;
  let lod: LodPyramid | null = null;
  let lodLevel = 0;
  let lodColor = 0xffb0b0b0;
  /** The level-0 node arrays, kept so going back down the pyramid does not need the caller. */
  let baseNodes: { xy: Float32Array; size: Float32Array; rgba: Uint32Array; n: number } | null = null;
  let atlas: GlyphAtlas | null = null;
  let labels: readonly (string | null)[] = [];
  let lastGlyphCount = 0;
  // Reused across frames so the label pass allocates NOTHING per frame — the point of bounding the
  // glyph count is lost if the bound is re-allocated 60 times a second.
  const labelRects = new Float32Array(MAX_LABEL_GLYPHS * 4);
  const labelUvs = new Float32Array(MAX_LABEL_GLYPHS * 4);
  let visible = new Uint32Array(4096);

  const uNode = {
    pos: gl.getUniformLocation(nodeProg, "uPos"),
    surface: gl.getUniformLocation(nodeProg, "uSurface"),
    border: gl.getUniformLocation(nodeProg, "uBorder"),
    accent: gl.getUniformLocation(nodeProg, "uAccent"),
    viewport: gl.getUniformLocation(nodeProg, "uViewport"),
    translate: gl.getUniformLocation(nodeProg, "uTranslate"),
    scale: gl.getUniformLocation(nodeProg, "uScale"),
  };
  const uLabel = {
    atlas: gl.getUniformLocation(labelProg, "uAtlas"),
    viewport: gl.getUniformLocation(labelProg, "uViewport"),
    color: gl.getUniformLocation(labelProg, "uColor"),
  };
  const uEdge = {
    pos: gl.getUniformLocation(edgeProg, "uPos"),
    viewport: gl.getUniformLocation(edgeProg, "uViewport"),
    translate: gl.getUniformLocation(edgeProg, "uTranslate"),
    scale: gl.getUniformLocation(edgeProg, "uScale"),
    width: gl.getUniformLocation(edgeProg, "uWidthPx"),
  };

  gl.bindTexture(gl.TEXTURE_2D, posTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl.bindTexture(gl.TEXTURE_2D, atlasTex);
  // LINEAR: the field is meant to be interpolated — nearest sampling would step the distance and put
  // the antialiasing back where it started.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl.bindVertexArray(labelVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, unitQuadBuf);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, labelRectBuf);
  gl.bufferData(gl.ARRAY_BUFFER, labelRects.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0); gl.vertexAttribDivisor(1, 1);
  gl.bindBuffer(gl.ARRAY_BUFFER, labelUvBuf);
  gl.bufferData(gl.ARRAY_BUFFER, labelUvs.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 0, 0); gl.vertexAttribDivisor(2, 1);
  gl.bindVertexArray(null);

  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  // Premultiplied source: the shaders already multiply rgb by alpha, which is what keeps a soft SDF edge
  // from fringing dark against a light background.
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  const unpackRgba = (packed: Uint32Array, n: number): Uint8Array =>
    new Uint8Array(packed.buffer, packed.byteOffset, n * 4);

  function setNodes(xy: Float32Array, size: Float32Array, rgba: Uint32Array, count: number): void {
    baseNodes = { xy, size, rgba, n: Math.max(0, Math.min(count, xy.length >> 1, size.length, rgba.length)) };
    uploadNodes(xy, size, rgba, count);
  }

  /** The upload itself, without recording it as the base set — used when swapping to an LOD level. */
  function uploadNodes(xy: Float32Array, size: Float32Array, rgba: Uint32Array, count: number): void {
    nodeCount = Math.max(0, Math.min(count, xy.length >> 1, size.length >> 1, rgba.length));
    positions = xy;
    gridStale = true;

    posRows = Math.max(1, Math.ceil(nodeCount / POS_TEX_W));
    // The texture is a fixed-width rectangle; the tail of the last row is padding the shader never reads.
    const padded = new Float32Array(POS_TEX_W * posRows * 2);
    padded.set(xy.subarray(0, nodeCount * 2));
    gl.bindTexture(gl.TEXTURE_2D, posTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, POS_TEX_W, posRows, 0, gl.RG, gl.FLOAT, padded);

    // Half-extents per axis — picking is a RECTANGLE, not a circle. A circle of radius max(w,h)/2 on a
    // 172x58 card reaches 86 px vertically and selects a node a whole row away.
    halfW = new Float32Array(nodeCount);
    halfH = new Float32Array(nodeCount);
    maxRadius = 0;
    for (let i = 0; i < nodeCount; i++) {
      const w = size[i * 2] * 0.5, h = size[i * 2 + 1] * 0.5;
      halfW[i] = w;
      halfH[i] = h;
      // The grid query reach must still cover the largest half-extent on EITHER axis, or a wide card is
      // unpickable near its ends.
      if (w > maxRadius) maxRadius = w;
      if (h > maxRadius) maxRadius = h;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, sizeBuf);
    gl.bufferData(gl.ARRAY_BUFFER, size.subarray(0, nodeCount * 2), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuf);
    gl.bufferData(gl.ARRAY_BUFFER, unpackRgba(rgba, nodeCount), gl.STATIC_DRAW);
    stateBytes = new Uint8Array(nodeCount);
    gl.bindBuffer(gl.ARRAY_BUFFER, stateBuf);
    gl.bufferData(gl.ARRAY_BUFFER, stateBytes, gl.DYNAMIC_DRAW);

    gl.bindVertexArray(nodeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, nodeQuadBuf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, sizeBuf);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0); gl.vertexAttribDivisor(1, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuf);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 0, 0); gl.vertexAttribDivisor(2, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, stateBuf);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.UNSIGNED_BYTE, true, 0, 0); gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);
  }

  function setEdges(pairs: Uint32Array, count: number): void {
    edgeCount = Math.max(0, Math.min(count, pairs.length >> 1));
    gl.bindBuffer(gl.ARRAY_BUFFER, pairBuf);
    gl.bufferData(gl.ARRAY_BUFFER, pairs.subarray(0, edgeCount * 2), gl.STATIC_DRAW);
    // One flat colour for now: per-edge colouring is a later slice, and a uniform would not survive it,
    // so the attribute exists from the start and is simply filled with the same value.
    const col = new Uint8Array(edgeCount * 4);
    const r = edgeColor & 255, g2 = (edgeColor >>> 8) & 255, b = (edgeColor >>> 16) & 255, a = (edgeColor >>> 24) & 255;
    for (let i = 0; i < edgeCount; i++) { col[i * 4] = r; col[i * 4 + 1] = g2; col[i * 4 + 2] = b; col[i * 4 + 3] = a; }
    gl.bindBuffer(gl.ARRAY_BUFFER, edgeColorBuf);
    gl.bufferData(gl.ARRAY_BUFFER, col, gl.STATIC_DRAW);

    gl.bindVertexArray(edgeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, edgeQuadBuf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, pairBuf);
    // INTEGER attribute — `vertexAttribPointer` would silently convert to float and lose precision above
    // 2^24, which is inside the range a million-node graph reaches.
    gl.enableVertexAttribArray(1); gl.vertexAttribIPointer(1, 2, gl.UNSIGNED_INT, 0, 0); gl.vertexAttribDivisor(1, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, edgeColorBuf);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 0, 0); gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);
  }

  function setState(index: number, state: number): void {
    if (index < 0 || index >= nodeCount) return;
    stateBytes[index] = state & 255;
    gl.bindBuffer(gl.ARRAY_BUFFER, stateBuf);
    // The whole point: ONE byte at one offset. Re-uploading the buffer would make selection O(N) again,
    // which is the 371 ms this module exists to remove.
    gl.bufferSubData(gl.ARRAY_BUFFER, index, stateBytes.subarray(index, index + 1));
  }

  function setPosition(index: number, x: number, y: number): void {
    if (index < 0 || index >= nodeCount) return;
    positions[index * 2] = x;
    positions[index * 2 + 1] = y;
    gridStale = true;
    gl.bindTexture(gl.TEXTURE_2D, posTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, index % POS_TEX_W, (index / POS_TEX_W) | 0, 1, 1, gl.RG, gl.FLOAT, new Float32Array([x, y]));
  }

  function setView(v: GraphView): void { view = v; }

  // `dpr` scales only the DRAWING BUFFER. The shaders work in CSS px against `uViewport`, and clip space
  // spans the whole buffer, so device-pixel scaling falls out of `gl.viewport` with no other change.
  function resize(cssW: number, cssH: number, dpr = 1): void {
    vpW = Math.max(1, Math.round(cssW));
    vpH = Math.max(1, Math.round(cssH));
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
  }

  function draw(): void {
    // O(1): the level is arithmetic on the view scale. The swap below is skipped unless it changed.
    if (lod) applyLevel(levelFor(lod, view.scale));
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, posTex);

    // Edges first so nodes sit on top — the same ordering the DOM graph got from `orderedEdges`, for
    // free, because it is just draw order.
    if (edgeCount > 0) {
      gl.useProgram(edgeProg);
      gl.uniform1i(uEdge.pos, 0);
      gl.uniform2f(uEdge.viewport, vpW, vpH);
      gl.uniform2f(uEdge.translate, view.tx, view.ty);
      gl.uniform1f(uEdge.scale, view.scale);
      gl.uniform1f(uEdge.width, edgeWidthPx);
      gl.bindVertexArray(edgeVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, edgeCount);
    }
    if (nodeCount > 0) {
      gl.useProgram(nodeProg);
      gl.uniform1i(uNode.pos, 0);
      gl.uniform2f(uNode.viewport, vpW, vpH);
      gl.uniform2f(uNode.translate, view.tx, view.ty);
      gl.uniform1f(uNode.scale, view.scale);
      gl.uniform4f(uNode.surface, surfaceRgba[0], surfaceRgba[1], surfaceRgba[2], surfaceRgba[3]);
      gl.uniform4f(uNode.border, borderRgba[0], borderRgba[1], borderRgba[2], borderRgba[3]);
      gl.uniform4f(uNode.accent, accentRgba[0], accentRgba[1], accentRgba[2], accentRgba[3]);
      gl.bindVertexArray(nodeVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nodeCount);
    }
    // Labels LAST so they sit above both nodes and edges, and because the pass is skipped entirely when
    // nothing is legible — which is the common case at overview zoom.
    lastGlyphCount = buildLabelInstances();
    if (lastGlyphCount > 0) {
      gl.useProgram(labelProg);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, atlasTex);
      gl.uniform1i(uLabel.atlas, 1);
      gl.uniform2f(uLabel.viewport, vpW, vpH);
      gl.uniform4f(uLabel.color, textRgba[0], textRgba[1], textRgba[2], textRgba[3]);
      gl.bindVertexArray(labelVao);
      // Only the glyphs actually written are uploaded — the buffers are allocated once at full capacity
      // and re-filled, so a frame with 200 labels does not pay for a capacity of 20,000.
      gl.bindBuffer(gl.ARRAY_BUFFER, labelRectBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, labelRects, 0, lastGlyphCount * 4);
      gl.bindBuffer(gl.ARRAY_BUFFER, labelUvBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, labelUvs, 0, lastGlyphCount * 4);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, lastGlyphCount);
    }
    gl.bindVertexArray(null);
  }

  /**
   * Swap the drawn geometry to pyramid level `k` — `O(m)` in that level's population, and paid ONLY when
   * the level changes, not per frame.
   *
   * Reuses the ordinary node upload rather than keeping a separate VAO and texture per level. Levels
   * change a handful of times across a whole zoom sweep, so re-uploading ~n/4 floats on a transition is
   * cheaper than the state and the code that per-level buffers would cost — and it means the LOD path
   * runs through geometry that is already tested.
   */
  // NOT `useLevel`: a `use` prefix in this codebase means a React hook, and the lint rule that enforces
  // that is right to — this is a plain function inside a factory, and calling it from `draw` would have
  // read as a hook call outside a component to anyone scanning the file.
  function applyLevel(k: number): void {
    if (!lod || k === lodLevel) return;
    lodLevel = k;
    if (k === 0) {
      if (baseNodes) uploadNodes(baseNodes.xy, baseNodes.size, baseNodes.rgba, baseNodes.n);
      return;
    }
    const lv = lod.levels[k];
    const size = new Float32Array(lv.n * 2);
    const rgba = new Uint32Array(lv.n);
    // An aggregate is drawn at its CELL size, so the level tiles the space it stands for instead of
    // leaving gaps that read as missing data. Square, unlike the cards it stands for — a cell IS square.
    size.fill(lv.cellSize);
    rgba.fill(lodColor);
    uploadNodes(lv.xy, size, rgba, lv.n);
  }

  function setLod(p: LodPyramid | null, aggregateColor?: number): void {
    lod = p;
    if (aggregateColor !== undefined) lodColor = aggregateColor;
    // Force the next draw to re-evaluate: the pyramid may have changed under the same level number.
    lodLevel = -1;
    if (!p && baseNodes) {
      lodLevel = 0;
      uploadNodes(baseNodes.xy, baseNodes.size, baseNodes.rgba, baseNodes.n);
    }
  }

  function setPalette(
    s: readonly number[],
    b: readonly number[],
    a: readonly number[],
    text?: readonly number[],
  ): void {
    const four = (v: readonly number[] | undefined, d: [number, number, number, number]): [number, number, number, number] =>
      v && v.length >= 3 ? [v[0], v[1], v[2], v.length > 3 ? v[3] : 1] : d;
    surfaceRgba = four(s, surfaceRgba);
    borderRgba = four(b, borderRgba);
    accentRgba = four(a, accentRgba);
    // Optional: a caller written before the label colour existed keeps the previous default rather than
    // getting a transparent — an invisible label is the bug this is fixing.
    textRgba = four(text, textRgba);
  }

  function setAtlas(a: GlyphAtlas): void {
    atlas = a;
    gl.bindTexture(gl.TEXTURE_2D, atlasTex);
    // R8, one byte per texel: the field is a single channel, and storing it as RGBA would quadruple a
    // texture that is uploaded once and sampled constantly.
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, a.width, a.height, 0, gl.RED, gl.UNSIGNED_BYTE, a.data);
  }

  function setLabels(l: readonly (string | null)[]): void {
    labels = l;
  }

  /**
   * Fill the glyph instance buffers for everything on screen and legible — `O(visible glyphs)`.
   *
   * The gate is what makes this bounded: a node whose label would render under `MIN_LABEL_PX` is
   * skipped entirely, so the cost tracks SCREEN AREA rather than node count. A million-node graph
   * zoomed out emits zero glyphs and costs one `queryRect`.
   */
  function buildLabelInstances(): number {
    if (!atlas || labels.length === 0 || nodeCount === 0) return 0;
    if (gridStale || !grid) { grid = buildGrid(positions, nodeCount); gridStale = false; }
    // The world rect the viewport currently shows. No margin: unlike a DOM graph there is nothing to
    // pre-mount, and a label that appears as it enters the screen is correct.
    const wx = -view.tx / view.scale;
    const wy = -view.ty / view.scale;
    const ww = vpW / view.scale;
    const wh = vpH / view.scale;
    if (visible.length < nodeCount && visible.length < 1 << 20) {
      visible = new Uint32Array(Math.min(nodeCount, 1 << 20));
    }
    const n = queryRect(grid, wx, wy, ww, wh, visible);
    let g = 0;
    for (let k = 0; k < n; k++) {
      const i = visible[k];
      const text = labels[i];
      if (!text) continue;
      // Label em size follows the node, so text zooms with the graph rather than floating free of it.
      // The label follows the card's HEIGHT, not its width: a 172x58 card sized off its long axis would
      // put ~55 px of text on a 58 px card.
      // The NAME's own size, mirroring .ds-node-name (13px on a 58px card) rather than a fraction of
      // the box. The text sits INSIDE the card now, so it has to match the card's type scale or it
      // overlaps the second row.
      const emPx = (halfH[i] * 2) * (13 / 58) * view.scale;
      if (emPx < MIN_LABEL_PX) continue;
      const scale = emPx / atlas.fontSize;
      const laid = layoutLabel(text, atlas);
        // Left-aligned at the grid's name column: padding-left 13 + the 8px dot + an 8px column gap
        // = 29 card units in from the left edge. It used to be centred UNDER the node.
        const leftPx = (positions[i * 2] - halfW[i]) * view.scale + view.tx;
        const originX = leftPx + (halfH[i] * 2) * (29 / 58) * view.scale;
        // The name row's baseline: padding-top 11 plus the row's own height, in card units.
        const topPx = (positions[i * 2 + 1] - halfH[i]) * view.scale + view.ty;
        const originY = topPx + (halfH[i] * 2) * (23 / 58) * view.scale;
      for (const pg of laid.glyphs) {
        if (g >= MAX_LABEL_GLYPHS) return g;
        const q = pg.glyph;
        labelRects[g * 4] = originX + pg.x * scale;
        labelRects[g * 4 + 1] = originY + pg.y * scale;
        labelRects[g * 4 + 2] = q.w * scale;
        labelRects[g * 4 + 3] = q.h * scale;
        labelUvs[g * 4] = q.x / atlas.width;
        labelUvs[g * 4 + 1] = q.y / atlas.height;
        labelUvs[g * 4 + 2] = (q.x + q.w) / atlas.width;
        labelUvs[g * 4 + 3] = (q.y + q.h) / atlas.height;
        g++;
      }
    }
    return g;
  }

  function pick(cssX: number, cssY: number): number {
    if (nodeCount === 0) return -1;
    if (gridStale || !grid) { grid = buildGrid(positions, nodeCount); gridStale = false; }
    // Screen → world is the inverse of the shader's transform, so picking and drawing cannot disagree.
    const wx = (cssX - view.tx) / view.scale;
    const wy = (cssY - view.ty) / view.scale;
    // The reach must cover the LARGEST half-extent on either axis, or a wide card is unclickable near
    // its ends. Read, not computed — see `maxRadius`.
    return pickRect(grid, positions, halfW, halfH, wx, wy, maxRadius);
  }

  function dispose(): void {
    for (const b of [nodeQuadBuf, edgeQuadBuf, unitQuadBuf, sizeBuf, colorBuf, stateBuf, pairBuf, edgeColorBuf, labelRectBuf, labelUvBuf]) gl.deleteBuffer(b);
    gl.deleteTexture(posTex);
    gl.deleteTexture(atlasTex);
    gl.deleteVertexArray(nodeVao);
    gl.deleteVertexArray(edgeVao);
    gl.deleteVertexArray(labelVao);
    gl.deleteProgram(nodeProg);
    gl.deleteProgram(edgeProg);
    gl.deleteProgram(labelProg);
    // Deleting objects returns GPU memory; it does not return the CONTEXT. Browsers cap live WebGL
    // contexts (Chromium ~16) and force-lose the OLDEST past the cap, so a caller that creates and
    // disposes renderers repeatedly (a mount/unmount cycle, hasWebgl2's throwaway probe) can silently
    // evict a context another part of the page is still using.
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  return {
    setNodes, setEdges, setState, setPosition, setView, resize, draw, pick, dispose, setAtlas, setLabels, setLod, setPalette,
    get lodLevel() { return lodLevel < 0 ? 0 : lodLevel; },
    get nodeCount() { return nodeCount; },
    get edgeCount() { return edgeCount; },
    get lastGlyphCount() { return lastGlyphCount; },
  };
}
