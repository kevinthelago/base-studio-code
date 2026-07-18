import { describe, it, expect } from "vitest";
import { compileVizProgram, runVizProgram } from "./vizProgram";

describe("compileVizProgram", () => {
  it("compiles a valid array descriptor", () => {
    const d = compileVizProgram(`({ datatype: "array", input: [3, 1, 2], run(a) { a.swap(0, 1); } })`);
    expect(d.datatype).toBe("array");
    expect(d.input).toEqual([3, 1, 2]);
    expect(typeof d.run).toBe("function");
  });

  it("compiles a valid matrix descriptor", () => {
    const d = compileVizProgram(`({ datatype: "matrix", input: [[1, 2], [3, 4]], run(m) { m.read(0, 0); } })`);
    expect(d.datatype).toBe("matrix");
    expect(d.input).toEqual([[1, 2], [3, 4]]);
  });

  it("compiles a valid graph descriptor", () => {
    const code = `({ datatype: "graph", input: { nodes: [{ id: "a" }], edges: [] }, run(g) { g.visit("a"); } })`;
    const d = compileVizProgram(code);
    expect(d.datatype).toBe("graph");
    expect(d.input).toEqual({ nodes: [{ id: "a" }], edges: [] });
  });

  it("compiles a valid scene descriptor (multi-structure, seeds on a graph) (#3275)", () => {
    const code = `({ datatype: "scene", input: { nodes: [{ id: "a" }], edges: [] }, run(scene, input) { scene.graph("g", input); } })`;
    const d = compileVizProgram(code);
    expect(d.datatype).toBe("scene");
    expect(d.input).toEqual({ nodes: [{ id: "a" }], edges: [] });
  });

  it("rejects empty / whitespace code", () => {
    expect(() => compileVizProgram("")).toThrow(/empty/);
    expect(() => compileVizProgram("   ")).toThrow(/empty/);
  });

  it("rejects code that fails to evaluate", () => {
    expect(() => compileVizProgram("({ datatype: 'array', ")).toThrow(/failed to compile/);
  });

  it("rejects a non-object result", () => {
    expect(() => compileVizProgram("42")).toThrow(/must evaluate to a .* object/);
  });

  it("rejects an unknown datatype", () => {
    expect(() => compileVizProgram(`({ datatype: "tree", input: [1], run() {} })`)).toThrow(/datatype must be/);
  });

  it("rejects a missing / non-function run", () => {
    expect(() => compileVizProgram(`({ datatype: "array", input: [1], run: 5 })`)).toThrow(/run must be a function/);
  });

  it("rejects an input whose shape does not match the datatype", () => {
    // array datatype but a grid input
    expect(() => compileVizProgram(`({ datatype: "array", input: [[1]], run() {} })`)).toThrow(/does not match datatype "array"/);
    // matrix datatype but a flat array
    expect(() => compileVizProgram(`({ datatype: "matrix", input: [1, 2], run() {} })`)).toThrow(/does not match datatype "matrix"/);
    // graph datatype but no nodes/edges
    expect(() => compileVizProgram(`({ datatype: "graph", input: {}, run() {} })`)).toThrow(/does not match datatype "graph"/);
    // scene datatype but a flat array (a scene seeds on a graph)
    expect(() => compileVizProgram(`({ datatype: "scene", input: [1], run() {} })`)).toThrow(/does not match datatype "scene"/);
    // non-finite numbers are rejected
    expect(() => compileVizProgram(`({ datatype: "array", input: [1, NaN], run() {} })`)).toThrow(/does not match datatype "array"/);
  });

  it("cannot see the executor's module scope (strict, no injected bindings)", () => {
    // `compileVizProgram` is not in scope inside the evaluated program.
    expect(() => compileVizProgram(`({ datatype: "array", input: [1], run() { compileVizProgram; } })`)).not.toThrow();
    const d = compileVizProgram(`({ datatype: "array", input: [1], run() { compileVizProgram(); } })`);
    // Referencing it only fails when run() actually executes (ReferenceError) — proving no leak.
    expect(() => (d.run as () => void)()).toThrow(ReferenceError);
  });
});

// Per-op source provenance (#3250) — the END-TO-END proof that the animation and the code are paired:
// running a real program produces frames whose `loc` slices back out of the reported `source` as exactly
// the tracer call that emitted them. If instrumentation, the ambient location stack, or the offsets were
// wrong in any way, these slices would not read as the calls they name.
describe("runVizProgram source provenance (#3250)", () => {
  const CODE = `({
  datatype: "array",
  input: [3, 1, 2],
  run(a) {
    a.compare(0, 1);
    a.swap(0, 1);
    a.markSorted();
  },
})`;

  it("reports the TRIMMED source the frame ranges index into", () => {
    const run = runVizProgram(`\n  ${CODE}  \n`);
    expect(run.source).toBe(CODE);
  });

  it("stamps each op-frame with the range of the call that emitted it", () => {
    const { frames, source } = runVizProgram(CODE);
    // The opening at-rest frame precedes every op, so it deliberately carries no location.
    expect(frames[0].loc).toBeUndefined();

    const spans = frames.filter((f) => f.loc).map((f) => source.slice(f.loc!.start, f.loc!.end));
    expect(spans).toEqual(["a.compare(0, 1)", "a.swap(0, 1)", "a.markSorted()"]);
  });

  it("pairs each frame's op with the verb named in its own source span", () => {
    const { frames, source } = runVizProgram(CODE);
    for (const frame of frames) {
      // Narrow to the array structure so `ops` is the ArrayOp array (the union's other members key `ops`
      // differently — a scalar frame's is a Record, not a list).
      if (!frame.loc || !("structure" in frame) || frame.structure !== "array") continue;
      const op = frame.ops?.[0];
      if (!op) continue;
      const span = source.slice(frame.loc.start, frame.loc.end);
      // e.g. the frame carrying `{ op: "swap" }` points at the `a.swap(…)` call — not at a neighbouring one.
      expect(span).toContain(`.${op.op === "mark" ? "markSorted" : op.op}(`);
    }
  });

  it("carries the OUTER call's range back after a nested traced call returns", () => {
    // `a.get(…)` is silent (emits nothing), so the only frame here comes from `a.set(…)` — and it must
    // wear the OUTER range, not the inner read's. A single-slot location would report `a.get(1)`.
    const code = `({ datatype: "array", input: [3, 1, 2], run(a) { a.set(0, a.get(1)); } })`;
    const { frames, source } = runVizProgram(code);
    const stamped = frames.filter((f) => f.loc);
    expect(stamped).toHaveLength(1);
    expect(source.slice(stamped[0].loc!.start, stamped[0].loc!.end)).toBe("a.set(0, a.get(1))");
  });

  it("still runs — with no ranges — when the program cannot be instrumented", () => {
    // No tracer calls at all: nothing to instrument, but the program must still produce its trace.
    const { frames } = runVizProgram(`({ datatype: "array", input: [2, 1], run() {} })`);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((f) => f.loc === undefined)).toBe(true);
  });

  it("does not leak a stale location when a program throws mid-run", () => {
    const boom = `({ datatype: "array", input: [3, 1, 2], run(a) { a.swap(0, 1); throw new Error("boom"); } })`;
    expect(() => runVizProgram(boom)).toThrow(/boom/);
    // A leaked stack entry would stamp this UNINSTRUMENTED program's frames with the previous one's range.
    const after = runVizProgram(`({ datatype: "array", input: [2, 1], run() {} })`);
    expect(after.frames.every((f) => f.loc === undefined)).toBe(true);
  });
});
