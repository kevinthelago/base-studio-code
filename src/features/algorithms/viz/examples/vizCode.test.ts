import { describe, it, expect, vi } from "vitest";
import type { ArrayFrame } from "../../lib/trace";
import { vizForImpl, vizExampleFromCode } from "./registry";

// A real bubble sort as a STORED vizCode descriptor (#3232) — the persisted-data form of a trace-program.
const BUBBLE_VIZCODE = `({
  datatype: "array",
  input: [5, 2, 9, 1, 6],
  run(a) {
    for (let i = 0; i < a.length; i++)
      for (let j = 0; j < a.length - i - 1; j++)
        if (a.compare(j, j + 1) > 0) a.swap(j, j + 1);
  },
})`;

// A matrix descriptor, used to prove vizCode WINS over an impl's in-app array program.
const MATRIX_VIZCODE = `({
  datatype: "matrix",
  input: [[1, 2], [3, 4]],
  run(m) { m.read(0, 0); m.read(1, 1); },
})`;

describe("vizExampleFromCode", () => {
  it("builds an array example that RUNS the stored program (frames end sorted)", () => {
    const viz = vizExampleFromCode(BUBBLE_VIZCODE)!;
    expect(viz).toBeDefined();
    expect(viz.renderers.array).toBeDefined();

    const frames = [...viz.factory()] as ArrayFrame[];
    expect(frames.length).toBeGreaterThan(0);
    // The program's real mechanics show up: at least one swap op was recorded.
    expect(frames.some((f) => f.ops?.some((o) => o.op === "swap"))).toBe(true);
    // And running the real algorithm sorts the input — the LAST frame's data is ascending.
    expect(frames[frames.length - 1].data).toEqual([1, 2, 5, 6, 9]);
  });

  it("re-runs the program on user input via the input seam", () => {
    const viz = vizExampleFromCode(BUBBLE_VIZCODE)!;
    const parsed = viz.input.parse("4, 3, 2, 1");
    const frames = [...viz.input.make(parsed)] as ArrayFrame[];
    expect(frames[frames.length - 1].data).toEqual([1, 2, 3, 4]);
  });

  it("dispatches datatype → renderer (matrix descriptor → matrix renderer)", () => {
    const viz = vizExampleFromCode(MATRIX_VIZCODE)!;
    expect(viz.renderers.matrix).toBeDefined();
    expect(viz.renderers.array).toBeUndefined();
  });

  it("caches by code string (stable example identity across calls)", () => {
    expect(vizExampleFromCode(BUBBLE_VIZCODE)).toBe(vizExampleFromCode(BUBBLE_VIZCODE));
  });

  it("returns undefined (and warns) for malformed code, cached so it never rethrows", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = `({ datatype: "array", input: [1], `; // syntax error
    expect(vizExampleFromCode(bad)).toBeUndefined();
    expect(vizExampleFromCode(bad)).toBeUndefined(); // cached — still fine
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("vizForImpl — stored vizCode preference (#3232)", () => {
  it("prefers a valid stored vizCode over the impl's in-app program", () => {
    // `bubble-sort.ts` HAS an in-app array program; its stored (matrix) vizCode must WIN.
    const viz = vizForImpl({ id: "bubble-sort.ts", name: "bubble", vizCode: MATRIX_VIZCODE })!;
    expect(viz.renderers.matrix).toBeDefined();
    expect(viz.renderers.array).toBeUndefined();
  });

  it("falls back to the in-app program when vizCode is malformed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const viz = vizForImpl({ id: "bubble-sort.ts", name: "bubble", vizCode: "not a descriptor {" })!;
    // The in-app bubble-sort program is an ARRAY example — proving the fallback, not a blank pane.
    expect(viz.renderers.array).toBeDefined();
    warn.mockRestore();
  });

  it("uses the in-app program when there is no vizCode", () => {
    const viz = vizForImpl({ id: "bubble-sort.ts", name: "bubble" })!;
    expect(viz.renderers.array).toBeDefined();
  });

  it("returns undefined when neither a vizCode nor an in-app program exists", () => {
    expect(vizForImpl({ id: "nonesuch.ts", name: "nonesuch" })).toBeUndefined();
  });
});
