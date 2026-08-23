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
import { buildGrid, pickNearest, type SpatialGrid } from "@/shared/lib/graph/spatialGrid";

/** Per-instance state byte. Drives appearance in the shader; never causes a re-upload of anything else. */
export const NODE_NORMAL = 0;
export const NODE_SELECTED = 1;
export const NODE_DIMMED = 2;

/** Width of the position texture. 2048 keeps it well inside every `MAX_TEXTURE_SIZE` we could meet
 *  (this webview reports 16384) while covering 1M nodes in 489 rows. */
const POS_TEX_W = 2048;

export interface GraphRenderer {
  /** Upload node positions/sizes/colours. O(n); rebuilds the pick index. `rgba` is packed 0xAABBGGRR. */
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
  dispose(): void;
  readonly nodeCount: number;
  readonly edgeCount: number;
}

const NODE_VS = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in float aSize;
layout(location=2) in vec4 aColor;
layout(location=3) in float aState;
uniform sampler2D uPos;
uniform vec2 uViewport;
uniform vec2 uTranslate;
uniform float uScale;
out vec2 vCorner; out vec4 vColor; out float vState; out float vPx;
void main() {
  ivec2 t = ivec2(gl_InstanceID % ${POS_TEX_W}, gl_InstanceID / ${POS_TEX_W});
  vec2 p = texelFetch(uPos, t, 0).rg;
  vec2 world = p + aCorner * (aSize * 0.5);
  vec2 s = world * uScale + uTranslate;
  gl_Position = vec4(s.x / uViewport.x * 2.0 - 1.0, 1.0 - s.y / uViewport.y * 2.0, 0.0, 1.0);
  vCorner = aCorner; vColor = aColor; vState = aState; vPx = aSize * uScale;
}`;

// Rounded-rect SDF. Chosen over a plain quad because the cost is PER-PIXEL, not per-node — the shape is
// free at any count — and because it stays crisp at every zoom where a bitmap or a CSS border would not.
const NODE_FS = `#version 300 es
precision mediump float;
in vec2 vCorner; in vec4 vColor; in float vState; in float vPx;
out vec4 outColor;
float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}
void main() {
  float d = sdRoundBox(vCorner, vec2(1.0), 0.35);
  // One pixel expressed in local (-1..1) units, so antialiasing is a constant screen width at any zoom.
  float aa = max(fwidth(d), 1.0 / max(vPx, 1.0));
  float fill = 1.0 - smoothstep(-aa, aa, d);
  if (fill <= 0.003) discard;
  float st = floor(vState * 255.0 + 0.5);
  vec3 rgb = vColor.rgb;
  float alpha = vColor.a;
  // A dimmed node keeps its hue and loses contrast; a selected one gets a bright ring rather than a
  // different fill, so selection reads at a glance without recolouring the graph.
  if (st == 2.0) { rgb = mix(rgb, vec3(0.5), 0.55); alpha *= 0.45; }
  if (st == 1.0) {
    float ring = 1.0 - smoothstep(-aa, aa, abs(d + 0.12) - 0.06);
    rgb = mix(rgb, vec3(1.0), ring * 0.85);
  }
  outColor = vec4(rgb * fill * alpha, fill * alpha);
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
  const ctx = canvas.getContext("webgl2", { antialias: false, alpha: true, premultipliedAlpha: true, depth: false });
  if (!ctx) return null;
  // Bound to its own non-nullable const: the closures below are FUNCTION DECLARATIONS, which hoist, so
  // TypeScript will not carry the `if (!ctx)` narrowing into them.
  const gl: WebGL2RenderingContext = ctx;

  const edgeWidthPx = opts.edgeWidthPx ?? 1.5;
  const edgeColor = opts.edgeColor ?? 0x66808080;

  let nodeProg: WebGLProgram, edgeProg: WebGLProgram;
  try {
    nodeProg = link(gl, NODE_VS, NODE_FS);
    edgeProg = link(gl, EDGE_VS, EDGE_FS);
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

  const sizeBuf = gl.createBuffer()!;
  const colorBuf = gl.createBuffer()!;
  const stateBuf = gl.createBuffer()!;
  const pairBuf = gl.createBuffer()!;
  const edgeColorBuf = gl.createBuffer()!;
  const posTex = gl.createTexture()!;
  const nodeVao = gl.createVertexArray()!;
  const edgeVao = gl.createVertexArray()!;

  let nodeCount = 0;
  let edgeCount = 0;
  let posRows = 1;
  let stateBytes = new Uint8Array(0);
  // Annotated: an un-annotated `new Float32Array(0)` infers `Float32Array<ArrayBuffer>`, which refuses the
  // caller's `Float32Array` (ArrayBufferLike) under TS 5.7 typed-array generics.
  let positions: Float32Array = new Float32Array(0);
  let radii = new Float32Array(0);
  /** The largest node radius, kept as the pick search reach. Computed ONCE per `setNodes`: deriving it
   *  inside `pick` was an O(n) scan on every mousemove, which would have quietly cost more than the
   *  index saves and made the O(1) claim false. */
  let maxRadius = 0;
  let grid: SpatialGrid | null = null;
  let gridStale = true;
  let view: GraphView = { tx: 0, ty: 0, scale: 1 };
  let vpW = 1, vpH = 1;

  const uNode = {
    pos: gl.getUniformLocation(nodeProg, "uPos"),
    viewport: gl.getUniformLocation(nodeProg, "uViewport"),
    translate: gl.getUniformLocation(nodeProg, "uTranslate"),
    scale: gl.getUniformLocation(nodeProg, "uScale"),
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

  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  // Premultiplied source: the shaders already multiply rgb by alpha, which is what keeps a soft SDF edge
  // from fringing dark against a light background.
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  const unpackRgba = (packed: Uint32Array, n: number): Uint8Array =>
    new Uint8Array(packed.buffer, packed.byteOffset, n * 4);

  function setNodes(xy: Float32Array, size: Float32Array, rgba: Uint32Array, count: number): void {
    nodeCount = Math.max(0, Math.min(count, xy.length >> 1, size.length, rgba.length));
    positions = xy;
    gridStale = true;

    posRows = Math.max(1, Math.ceil(nodeCount / POS_TEX_W));
    // The texture is a fixed-width rectangle; the tail of the last row is padding the shader never reads.
    const padded = new Float32Array(POS_TEX_W * posRows * 2);
    padded.set(xy.subarray(0, nodeCount * 2));
    gl.bindTexture(gl.TEXTURE_2D, posTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, POS_TEX_W, posRows, 0, gl.RG, gl.FLOAT, padded);

    radii = new Float32Array(nodeCount);
    maxRadius = 0;
    for (let i = 0; i < nodeCount; i++) {
      const r = size[i] * 0.5;
      radii[i] = r;
      if (r > maxRadius) maxRadius = r;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, sizeBuf);
    gl.bufferData(gl.ARRAY_BUFFER, size.subarray(0, nodeCount), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuf);
    gl.bufferData(gl.ARRAY_BUFFER, unpackRgba(rgba, nodeCount), gl.STATIC_DRAW);
    stateBytes = new Uint8Array(nodeCount);
    gl.bindBuffer(gl.ARRAY_BUFFER, stateBuf);
    gl.bufferData(gl.ARRAY_BUFFER, stateBytes, gl.DYNAMIC_DRAW);

    gl.bindVertexArray(nodeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, nodeQuadBuf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, sizeBuf);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0); gl.vertexAttribDivisor(1, 1);
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
      gl.bindVertexArray(nodeVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nodeCount);
    }
    gl.bindVertexArray(null);
  }

  function pick(cssX: number, cssY: number): number {
    if (nodeCount === 0) return -1;
    if (gridStale || !grid) { grid = buildGrid(positions, nodeCount); gridStale = false; }
    // Screen → world is the inverse of the shader's transform, so picking and drawing cannot disagree.
    const wx = (cssX - view.tx) / view.scale;
    const wy = (cssY - view.ty) / view.scale;
    // The reach must cover the LARGEST node, or a big node is unclickable near its own edge. Read, not
    // computed — see `maxRadius`.
    return pickNearest(grid, positions, radii, wx, wy, maxRadius);
  }

  function dispose(): void {
    for (const b of [nodeQuadBuf, edgeQuadBuf, sizeBuf, colorBuf, stateBuf, pairBuf, edgeColorBuf]) gl.deleteBuffer(b);
    gl.deleteTexture(posTex);
    gl.deleteVertexArray(nodeVao);
    gl.deleteVertexArray(edgeVao);
    gl.deleteProgram(nodeProg);
    gl.deleteProgram(edgeProg);
  }

  return {
    setNodes, setEdges, setState, setPosition, setView, resize, draw, pick, dispose,
    get nodeCount() { return nodeCount; },
    get edgeCount() { return edgeCount; },
  };
}
