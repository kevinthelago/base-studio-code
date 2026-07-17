import { describe, it, expect } from "vitest";
import { compileVizProgram } from "./vizProgram";

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
