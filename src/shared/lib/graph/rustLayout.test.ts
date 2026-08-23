// The transport contract, without Tauri. What matters here is that a malformed payload is REFUSED
// rather than quietly reinterpreted — a byte count that is not a whole number of nodes shifts every
// node after the discrepancy and reads as a layout bug.
import { describe, it, expect } from "vitest";
import { decodeLayout, packEdges } from "@/shared/lib/graph/rustLayout";

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
