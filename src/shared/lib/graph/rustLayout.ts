// The frontend half of `graph_layout` — the binary layout transport (`wire-the-rust-layout-into-the-app`).
//
// WHY BINARY, restated where the decode happens. Tauri's IPC is JSON by default, and a million nodes as
// a JSON number array is ~100 MB of text and seconds of `JSON.parse` on the main thread — more than the
// 256 ms layout it delivers. The Rust side returns `tauri::ipc::Response`, so the payload arrives as an
// `ArrayBuffer` and becomes a `Float32Array` with one view, no per-node allocation and nothing to parse.
//
// This is the first binary command in the app. Anything else shipping bulk numeric data should copy the
// shape rather than reach for JSON.

/** Interleaved `[x0,y0, x1,y1, …]` — exactly what `GraphRenderer.setNodes` takes. */
export interface RustLayout {
  xy: Float32Array;
  /** Node count, derived from the payload rather than trusted from the request. */
  count: number;
}

export interface RustLayoutOpts {
  spacingX?: number;
  spacingY?: number;
  /** Barycenter sweeps. More is tidier and costs `O(passes * (E + V log V))`. */
  passes?: number;
  /** Skip the content-hash cache — for measuring the layout itself. */
  noCache?: boolean;
}

/**
 * Decode the command's payload — `O(1)`, a view rather than a copy.
 *
 * Pure and exported so the contract can be tested without Tauri: the byte length must be an exact
 * multiple of 8 (two `f32` per node). A payload that is not silently shifts every node after the
 * discrepancy, which looks like a layout bug rather than a transport one.
 */
export function decodeLayout(buf: ArrayBuffer): RustLayout {
  if (buf.byteLength % 8 !== 0) {
    throw new Error(`graph_layout: ${buf.byteLength} bytes is not a whole number of nodes (8 bytes each)`);
  }
  const xy = new Float32Array(buf);
  return { xy, count: xy.length >> 1 };
}

/**
 * Flatten an edge list of index pairs into the `[from,to,…]` the command takes — `O(e)`.
 *
 * Edges naming a node outside `0..nodeCount` are DROPPED here as well as in Rust. Doing it on both
 * sides is deliberate: the Rust drop is the guarantee, and this one keeps the payload from carrying
 * data that will only be thrown away after crossing the IPC boundary.
 */
export function packEdges(edges: readonly (readonly [number, number])[], nodeCount: number): Uint32Array {
  const out = new Uint32Array(edges.length * 2);
  let n = 0;
  for (const [a, b] of edges) {
    if (a === b || a < 0 || b < 0 || a >= nodeCount || b >= nodeCount) continue;
    out[n++] = a;
    out[n++] = b;
  }
  return out.subarray(0, n);
}

/**
 * Lay out a graph in Rust and get positions back as a typed array.
 *
 * `O(V + E + passes*(E + V log V))` in Rust — 1,000,000 nodes and 2,000,000 edges measured at 256 ms —
 * and `O(1)` on a cache hit, which is the point of computing it there rather than here.
 *
 * Throws on a refused request (a hostile node count) rather than returning an empty layout: a graph
 * silently placed at the origin is indistinguishable from a layout bug.
 */
export async function rustLayout(
  nodeCount: number,
  edges: Uint32Array,
  opts: RustLayoutOpts = {},
): Promise<RustLayout> {
  const invoke = (globalThis as {
    __TAURI_INTERNALS__?: { invoke: (c: string, a: unknown, o?: unknown) => Promise<unknown> };
  }).__TAURI_INTERNALS__?.invoke;
  if (!invoke) throw new Error("graph_layout: no Tauri IPC (running outside the app shell)");
  // THE EDGE LIST IS THE BODY, not an argument. `Array.from` used to sit here to feed JSON, and it was
  // 38 ms of the 226 ms round trip at 600,000 edges — pure transport tax on the way to a 256 ms layout
  // of a graph three times larger. A `Uint8Array` body crosses as bytes and is 16 MB at 2M edges where
  // the JSON was ~40 MB of text plus a parse.
  //
  // `edges.buffer` is NOT used directly: a view may be a window onto a larger buffer (`subarray`), and
  // sending the whole buffer would ship a longer edge list than the caller passed.
  const body = new Uint8Array(edges.buffer, edges.byteOffset, edges.byteLength);
  // The scalars ride as headers, so the body stays nothing but edges. Header values are strings, and an
  // absent one is the command's documented default — so an undefined option is simply not sent.
  const headers: Record<string, string> = { "x-node-count": String(nodeCount) };
  if (opts.spacingX !== undefined) headers["x-spacing-x"] = String(opts.spacingX);
  if (opts.spacingY !== undefined) headers["x-spacing-y"] = String(opts.spacingY);
  if (opts.passes !== undefined) headers["x-passes"] = String(opts.passes);
  if (opts.noCache !== undefined) headers["x-no-cache"] = String(opts.noCache);
  const res = await invoke("graph_layout", body, { headers });
  if (!(res instanceof ArrayBuffer)) {
    // The whole reason this command exists is that it does NOT come back as JSON. If it ever does, the
    // transport regressed to the thing it was built to avoid, and that must be loud.
    throw new Error(`graph_layout: expected an ArrayBuffer, got ${Object.prototype.toString.call(res)}`);
  }
  return decodeLayout(res);
}
