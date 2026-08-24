// The transport contract, without Tauri. What matters here is that a malformed payload is REFUSED
// rather than quietly reinterpreted — a byte count that is not a whole number of nodes shifts every
// node after the discrepancy and reads as a layout bug.
import { describe, it, expect } from "vitest";
import { decodeLayout, packEdges, rustLayout } from "@/shared/lib/graph/rustLayout";

describe("decodeLayout", () => {
  it("views the payload as interleaved x,y without copying", () => {
    const src = new Float32Array([1, 2, 3, 4, 5, 6]);
    const got = decodeLayout(src.buffer);
    expect(got.count).toBe(3);
    expect([...got.xy]).toEqual([1, 2, 3, 4, 5, 6]);
    // A VIEW, not a copy — the whole point of the binary transport.
    expect(got.xy.buffer).toBe(src.buffer);
  });

  it("REFUSES a payload that is not a whole number of nodes", () => {
    expect(() => decodeLayout(new ArrayBuffer(12))).toThrow(/whole number of nodes/);
    expect(() => decodeLayout(new ArrayBuffer(5))).toThrow();
  });

  it("accepts an empty payload — an empty graph is a real state", () => {
    expect(decodeLayout(new ArrayBuffer(0))).toEqual({ xy: new Float32Array(0), count: 0 });
  });

  it("is 8 bytes per node, the contract the Rust side asserts from its end", () => {
    for (const n of [1, 7, 1000]) {
      expect(decodeLayout(new ArrayBuffer(n * 8)).count).toBe(n);
    }
  });
});

describe("packEdges", () => {
  it("flattens pairs into the flat list the command takes", () => {
    expect([...packEdges([[0, 1], [1, 2]], 3)]).toEqual([0, 1, 1, 2]);
  });

  it("drops self-loops and out-of-range endpoints before they cross the IPC boundary", () => {
    // Rust drops these too; doing it here keeps the payload from carrying data that will be discarded
    // after being serialized, which at a million edges is the expensive half.
    expect([...packEdges([[0, 0], [0, 5], [-1, 1], [1, 2]], 3)]).toEqual([1, 2]);
  });

  it("returns an empty array for no usable edges, not a padded one", () => {
    expect(packEdges([[0, 0]], 2).length).toBe(0);
    expect(packEdges([], 5).length).toBe(0);
  });
});

describe("the request crosses as BYTES, not as JSON", () => {
  // the-layout-request-is-still-json-only-the-response-is-binary. The response was binary from the
  // start; the edge list — twice the size of the output — was still a JSON number array, and
  // `Array.from` alone was 38 ms of the 226 ms round trip at 600,000 edges.
  function withInvoke(spy: (cmd: string, args: unknown, opts?: unknown) => Promise<unknown>) {
    const g = globalThis as { __TAURI_INTERNALS__?: unknown };
    const prev = g.__TAURI_INTERNALS__;
    g.__TAURI_INTERNALS__ = { invoke: spy };
    return () => {
      g.__TAURI_INTERNALS__ = prev;
    };
  }

  it("sends the edge list as the raw body and the scalars as headers", async () => {
    let seen: { cmd: string; args: unknown; opts?: { headers?: Record<string, string> } } | null = null;
    const restore = withInvoke(async (cmd, args, opts) => {
      seen = { cmd, args, opts: opts as { headers?: Record<string, string> } };
      return new ArrayBuffer(16); // 2 nodes
    });
    try {
      await rustLayout(2, packEdges([[0, 1]], 2), { spacingX: 5, passes: 3 });
    } finally {
      restore();
    }
    const got = seen!;
    expect(got.cmd).toBe("graph_layout");
    // THE assertion this item exists for: a byte view, not an array of numbers.
    expect(ArrayBuffer.isView(got.args)).toBe(true);
    expect(got.args).toBeInstanceOf(Uint8Array);
    // 1 edge = 2 u32 = 8 bytes.
    expect((got.args as Uint8Array).byteLength).toBe(8);
    expect(got.opts?.headers?.["x-node-count"]).toBe("2");
    expect(got.opts?.headers?.["x-spacing-x"]).toBe("5");
    expect(got.opts?.headers?.["x-passes"]).toBe("3");
    // An option not passed is not sent — absence IS the command's documented default.
    expect(got.opts?.headers?.["x-spacing-y"]).toBeUndefined();
    expect(got.opts?.headers?.["x-no-cache"]).toBeUndefined();
  });

  it("sends only the caller's edges when the view is a window onto a larger buffer", async () => {
    // `edges.buffer` would ship the WHOLE backing store — a `subarray` caller would silently lay out
    // edges it never passed, and the graph would come back subtly wrong rather than failing.
    const backing = new Uint32Array([9, 9, 0, 1, 9, 9]);
    const slice = backing.subarray(2, 4);
    let bytes = -1;
    const restore = withInvoke(async (_c, args) => {
      bytes = (args as Uint8Array).byteLength;
      return new ArrayBuffer(16);
    });
    try {
      await rustLayout(2, slice);
    } finally {
      restore();
    }
    expect(bytes).toBe(8);
  });
});
