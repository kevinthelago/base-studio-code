import { describe, it, expect, vi } from "vitest";
import type { ArrayFrame } from "../../lib/trace";
import { runVizProgram } from "./vizProgram";
import { resolveVizExample, programVizForImpl } from "./registry";

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

// A matrix descriptor, used to prove the datatype → renderer dispatch.
const MATRIX_VIZCODE = `({
  datatype: "matrix",
  input: [[1, 2], [3, 4]],
  run(m) { m.read(0, 0); m.read(1, 1); },
})`;

describe("runVizProgram — the pure compile+run core (#3233)", () => {
  it("runs the real array program (frames end sorted, swaps recorded)", () => {
    const { datatype, frames } = runVizProgram(BUBBLE_VIZCODE);
    expect(datatype).toBe("array");
    expect((frames as ArrayFrame[]).some((f) => f.ops?.some((o) => o.op === "swap"))).toBe(true);
    const last = (frames[frames.length - 1] as ArrayFrame).data as number[];
    expect(last).toEqual([1, 2, 5, 6, 9]);
  });

  it("runs on an overriding input (the 'your input' seam)", () => {
    const { frames } = runVizProgram(BUBBLE_VIZCODE, [4, 3, 2, 1]);
    expect((frames[frames.length - 1] as ArrayFrame).data).toEqual([1, 2, 3, 4]);
  });

  it("dispatches by datatype (matrix descriptor)", () => {
    expect(runVizProgram(MATRIX_VIZCODE).datatype).toBe("matrix");
  });

  it("throws on malformed code", () => {
    expect(() => runVizProgram("({ datatype: 'array', ")).toThrow(/failed to compile/);
  });
});

describe("resolveVizExample — sandbox-run stored vizCode (#3233)", () => {
  it("builds an array example whose factory replays the sandbox-computed sorted frames", async () => {
    const viz = (await resolveVizExample(BUBBLE_VIZCODE))!;
    expect(viz).toBeDefined();
    expect(viz.renderers.array).toBeDefined();
    const frames = [...viz.factory()] as ArrayFrame[];
    expect(frames[frames.length - 1].data).toEqual([1, 2, 5, 6, 9]);
  });

  it("re-runs the program on user input via the async input seam", async () => {
    const viz = (await resolveVizExample(BUBBLE_VIZCODE))!;
    const factory = await viz.input.make(viz.input.parse("4, 3, 2, 1"));
    const last = [...factory()].map((f) => (f as ArrayFrame).data);
    expect(last[last.length - 1]).toEqual([1, 2, 3, 4]);
  });

  it("dispatches datatype → renderer (matrix descriptor → matrix renderer)", async () => {
    const viz = (await resolveVizExample(MATRIX_VIZCODE))!;
    expect(viz.renderers.matrix).toBeDefined();
    expect(viz.renderers.array).toBeUndefined();
  });

  it("caches by code string (one sandbox run, stable resolved example)", async () => {
    const a = await resolveVizExample(BUBBLE_VIZCODE);
    const b = await resolveVizExample(BUBBLE_VIZCODE);
    expect(a).toBe(b);
  });

  it("resolves to undefined (and warns) for malformed code", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await resolveVizExample("({ datatype: 'array', ")).toBeUndefined(); // syntax error
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("programVizForImpl — in-app program lookup (sync)", () => {
  it("resolves a named algorithm to its own in-app program, undefined for an unknown one", () => {
    expect(programVizForImpl({ id: "bubble-sort.ts", name: "bubble" })?.renderers.array).toBeDefined();
    expect(programVizForImpl({ id: "transpose.ts", name: "transpose" })?.renderers.matrix).toBeDefined();
    expect(programVizForImpl({ id: "bfs.rs", name: "bfs" })?.renderers.graph).toBeDefined();
    expect(programVizForImpl({ id: "nonesuch.ts", name: "nonesuch" })).toBeUndefined();
  });
});
