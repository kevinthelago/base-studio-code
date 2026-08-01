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

  // #4162 — the three datatypes whose renderers shipped but which a STORED program could not name.
  it("compiles a valid tree descriptor, with the optional seed (#4162)", () => {
    const code = `({
      datatype: "tree",
      input: [50, 30, 70],
      seed: (values) => values.map((v, i) => ({ id: "n" + i, value: v, parent: i === 0 ? undefined : "n0" })),
      run(t, values) { t.compare("n0", "n1"); },
    })`;
    const d = compileVizProgram(code);
    expect(d.datatype).toBe("tree");
    expect(d.input).toEqual([50, 30, 70]);
    expect(typeof d.seed).toBe("function");
    // A tree that builds itself needs no seed — the tree simply starts empty.
    const bare = compileVizProgram(`({ datatype: "tree", input: [1], run(t) { t.insert("a", 1); } })`);
    expect(bare.seed).toBeUndefined();
  });

  it("compiles a valid stack descriptor, with the optional mode (#4162)", () => {
    const d = compileVizProgram(`({ datatype: "stack", input: "([])", mode: "queue", run(s, text) { s.push(text[0]); } })`);
    expect(d.datatype).toBe("stack");
    expect(d.input).toBe("([])");
    expect(d.mode).toBe("queue");
    // LIFO is the default, so the common case stays a three-field descriptor.
    expect(compileVizProgram(`({ datatype: "stack", input: "()", run(s) { s.push("("); } })`).mode).toBeUndefined();
  });

  it("compiles a valid scalar descriptor (#4162)", () => {
    const d = compileVizProgram(`({ datatype: "scalar", input: { n: 10 }, run(s) { s.set("fib", 0); } })`);
    expect(d.datatype).toBe("scalar");
    expect(d.input).toEqual({ n: 10 });
    // A seed may mix numbers and strings, and may be empty (the algorithm sets everything it uses).
    expect(compileVizProgram(`({ datatype: "scalar", input: { at: "a", i: 0 }, run() {} })`).datatype).toBe("scalar");
    expect(compileVizProgram(`({ datatype: "scalar", input: {}, run() {} })`).input).toEqual({});
  });

  it("rejects a malformed seed / mode rather than ignoring it (#4162)", () => {
    // Silently dropping either would animate something the author did not write.
    expect(() => compileVizProgram(`({ datatype: "tree", input: [1], seed: [], run() {} })`)).toThrow(/seed must be a function/);
    expect(() => compileVizProgram(`({ datatype: "stack", input: "()", mode: "heap", run() {} })`)).toThrow(/mode must be/);
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
    // `tree` used to be the example here — it is a REAL datatype since #4162, so this needs one that
    // genuinely has no renderer.
    expect(() => compileVizProgram(`({ datatype: "hypergraph", input: [1], run() {} })`)).toThrow(/datatype must be/);
    expect(() => compileVizProgram(`({ datatype: "hypergraph", input: [1], run() {} })`)).toThrow(/"tree"/);
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
    // #4162 — the new datatypes are guarded to the same standard, not waved through.
    expect(() => compileVizProgram(`({ datatype: "tree", input: "50,30", run() {} })`)).toThrow(/does not match datatype "tree"/);
    expect(() => compileVizProgram(`({ datatype: "stack", input: ["("], run() {} })`)).toThrow(/does not match datatype "stack"/);
    expect(() => compileVizProgram(`({ datatype: "scalar", input: [1, 2], run() {} })`)).toThrow(/does not match datatype "scalar"/);
    expect(() => compileVizProgram(`({ datatype: "scalar", input: { n: {} }, run() {} })`)).toThrow(/does not match datatype "scalar"/);
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

// #4162 — three of the six shipped renderers were reachable ONLY from an in-app program. `TracedTree`,
// `TracedStack` and `TracedScalar` all ship and `treeAlgos.ts`/`stackAlgos.ts`/`scalarAlgos.ts` drive
// them, but a stored `vizCode` naming one threw at compile — so bst-insert, bst-inorder, balanced-parens
// and postfix-eval could not be authored as DATA at all. These assert each one now runs end to end.
describe("runVizProgram over the tree / stack / scalar datatypes (#4162)", () => {
  const structures = (frames: readonly unknown[]) =>
    new Set(frames.map((f) => (f as { structure?: string }).structure).filter(Boolean));
  // `Array.prototype.at` is ES2022; the tsconfig lib target is ES2020.
  const last = (frames: readonly unknown[]) => frames[frames.length - 1] as { mode?: string; values?: Record<string, number | string> };

  it("tree: runs against the TracedTree and emits tree frames", () => {
    const code = `({
      datatype: "tree",
      input: [50, 30, 70],
      run(t, values) {
        t.insert("n0", values[0]);
        t.insert("n1", values[1], "n0");
        t.compare("n0", "n1");
      },
    })`;
    const run = runVizProgram(code);
    expect(run.datatype).toBe("tree");
    expect(run.frames.length).toBeGreaterThan(0);
    expect(structures(run.frames)).toEqual(new Set(["tree"]));
  });

  it("tree: `seed` starts the tree finished, so a traversal does not replay the build", () => {
    // The distinction the in-app `TreeProgram.seed` exists for — and the reason a stored tree program
    // needs it: without a seed, bst-inorder's animation would open with the whole insert sequence.
    const walk = `({
      datatype: "tree",
      input: [50, 30],
      seed: (values) => [{ id: "n0", value: values[0] }, { id: "n1", value: values[1], parent: "n0" }],
      run(t) { t.visit("n1"); t.visit("n0"); },
    })`;
    const seeded = runVizProgram(walk);
    const build = runVizProgram(`({
      datatype: "tree",
      input: [50, 30],
      run(t, values) { t.insert("n0", values[0]); t.insert("n1", values[1], "n0"); t.visit("n1"); t.visit("n0"); },
    })`);
    // Both end with both nodes present; only the seeded one skips the insert frames.
    expect(seeded.frames.length).toBeLessThan(build.frames.length);
    const first = seeded.frames[0] as { nodes?: { id: string }[] };
    expect(first.nodes?.map((n) => n.id)).toEqual(["n0", "n1"]);
  });

  it("stack: runs against the TracedStack, honoring `mode`", () => {
    const code = `({ datatype: "stack", input: "([)", run(s, text) {
      for (const ch of text) { if (ch === "(" || ch === "[") s.push(ch); else s.pop(); }
    } })`;
    const run = runVizProgram(code);
    expect(run.datatype).toBe("stack");
    expect(structures(run.frames)).toEqual(new Set(["stack"]));
    // FIFO is a different animation of the same program — the mode reaches the tracer. (`TracedStack`
    // stamps `mode` only when it is NOT the default, so the LIFO run's frames carry none.)
    const queue = runVizProgram(code.replace('input: "([)"', 'input: "([)", mode: "queue"'));
    expect(last(queue.frames).mode).toBe("queue");
    expect(last(run.frames).mode).toBeUndefined();
  });

  it("scalar: runs against the TracedScalar, seeded from the named-variable input", () => {
    // fibonacci's shape — the form the shipped `scalarAlgos.ts` program already uses.
    const code = `({ datatype: "scalar", input: { n: 5 }, run(s) {
      const n = Number(s.get("n"));
      s.set("a", 0); s.set("b", 1);
      for (let i = 2; i <= n; i++) { const a = Number(s.get("a")); const b = Number(s.get("b")); s.add("b", a); s.set("a", b); }
    } })`;
    const run = runVizProgram(code);
    expect(run.datatype).toBe("scalar");
    expect(structures(run.frames)).toEqual(new Set(["scalar"]));
    // F(5) = 5 — the seed really drove the recurrence.
    expect(last(run.frames).values?.b).toBe(5);
  });

  it("validates a caller's input override against the datatype", () => {
    // The "your input" seam parses text; a shape the runner cannot accept must fail loudly, not mid-trace.
    const code = `({ datatype: "stack", input: "()", run(s, text) { s.push(text[0]); } })`;
    expect(() => runVizProgram(code, ["("])).toThrow(/does not match datatype "stack"/);
    expect(runVizProgram(code, "[]").input).toBe("[]");
  });
});
