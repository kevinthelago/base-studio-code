// #3220 — the datatype axis is REACHABLE, not merely built.
//
// This is the test the epic actually needed. `TracedStack`/`TracedTree`, `<StackView>`/`<TreeView>`, their
// motion files, `treeLayout.ts` and their own unit tests all shipped — and none of it could be SELECTED,
// because `EXAMPLE_BY_KEY` only merged the array/search/scalar/matrix/graph/scene program groups. A stack
// or a tree could only be encountered as a panel inside a multi-structure scene. Everything passed; the
// feature was unreachable.
//
// So these assert the wiring itself: each datatype resolves to an example, carrying the renderer that
// draws it and an input seam that round-trips. A future datatype (linked-list, table — content-gated on
// #2760) joins the DATATYPES table below and inherits the same guarantees.
import { describe, it, expect } from "vitest";
import { programVizForImpl, resolveVizExample } from "./registry";
import { STACK_PROGRAMS } from "./stackAlgos";
import { TREE_PROGRAMS } from "./treeAlgos";
import { GRAPH_PROGRAMS } from "./graphAlgos";
import { MATRIX_PROGRAMS } from "./matrixTransforms";
import { SCALAR_PROGRAMS } from "./scalarAlgos";
import { SEARCH_PROGRAMS } from "./searches";
import { TRACE_PROGRAMS } from "./sorts";

/** Every structure that has selectable programs, and the renderer key each example must carry. */
const DATATYPES = [
  { structure: "array", renderer: "array", keys: Object.keys(TRACE_PROGRAMS) },
  { structure: "array (search)", renderer: "array", keys: Object.keys(SEARCH_PROGRAMS) },
  { structure: "scalar", renderer: "scalar", keys: Object.keys(SCALAR_PROGRAMS) },
  { structure: "matrix", renderer: "matrix", keys: Object.keys(MATRIX_PROGRAMS) },
  { structure: "graph", renderer: "graph", keys: Object.keys(GRAPH_PROGRAMS) },
  { structure: "stack", renderer: "stack", keys: Object.keys(STACK_PROGRAMS) },
  { structure: "tree", renderer: "tree", keys: Object.keys(TREE_PROGRAMS) },
] as const;

describe("datatype axis reachability (#3220)", () => {
  it.each(DATATYPES)("$structure programs are selectable and carry the $renderer renderer", ({ renderer, keys }) => {
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const example = programVizForImpl({ id: key });
      expect(example, key).toBeDefined();
      expect(Object.keys(example!.renderers), key).toContain(renderer);
      expect([...example!.factory()].length, key).toBeGreaterThan(1);
    }
  });

  it("the stack and tree renderers are no longer scene-only — the gap #3220 closes", () => {
    for (const key of [...Object.keys(STACK_PROGRAMS), ...Object.keys(TREE_PROGRAMS)]) {
      expect(programVizForImpl({ id: key }), key).toBeDefined();
    }
  });

  // `VizExample.input` documents the invariant `await make(parse(default))` reproduces `factory`. Asserted
  // for the datatypes THIS change adds: the older families predate it and proving them is a separate
  // question — one worth asking, but not one to answer by turning their behaviour into my regression.
  it("the new datatypes' input seams round-trip: parse(default) re-runs to the same trace", async () => {
    for (const key of [...Object.keys(STACK_PROGRAMS), ...Object.keys(TREE_PROGRAMS)]) {
      const ex = programVizForImpl({ id: key })!;
      const rerun = await ex.input.make(ex.input.parse(ex.input.default));
      expect([...rerun()], key).toEqual([...ex.factory()]);
    }
  });

  it("a program key resolves regardless of extension or separator casing", () => {
    // programKey strips ".rs"/".ts" and normalises separators — the datatype programs must survive it.
    expect(programVizForImpl({ id: "bst-inorder.ts" })).toBeDefined();
    expect(programVizForImpl({ id: "BST_INORDER" })).toBeDefined();
    expect(programVizForImpl({ id: "balanced-parens.rs" })).toBeDefined();
  });

  // #4162 — the SAME reachability question, one layer down: a STORED `vizCode` naming one of these
  // datatypes used to throw at compile, so `tree`/`stack`/`scalar` were reachable only from an in-app
  // module. Everything below runs the stored path end to end (compile → sandbox run → renderer pick).
  const STORED = [
    {
      datatype: "tree",
      renderer: "tree",
      code: `({ datatype: "tree", input: [50, 30], seed: (v) => [{ id: "n0", value: v[0] }], run(t, v) { t.insert("n1", v[1], "n0"); t.compare("n0", "n1"); } })`,
    },
    {
      datatype: "stack",
      renderer: "stack",
      code: `({ datatype: "stack", input: "([])", run(s, text) { for (const ch of text) { if (ch === "(" || ch === "[") s.push(ch); else s.pop(); } } })`,
    },
    {
      datatype: "scalar",
      renderer: "scalar",
      code: `({ datatype: "scalar", input: { n: 5 }, run(s) { s.set("a", 0); s.add("a", Number(s.get("n"))); } })`,
    },
  ] as const;

  it.each(STORED)("a STORED $datatype program resolves and carries the $renderer renderer (#4162)", async ({ renderer, code }) => {
    const ex = await resolveVizExample(code);
    expect(ex, renderer).toBeDefined();
    expect(Object.keys(ex!.renderers), renderer).toContain(renderer);
    expect([...ex!.factory()].length, renderer).toBeGreaterThan(1);
    // The code column pairs with the animation — a stored program's source is real provenance.
    expect(ex!.source, renderer).toBe(code);
  });

  it.each(STORED)("a STORED $datatype program's input seam round-trips", async ({ renderer, code }) => {
    const ex = await resolveVizExample(code);
    const rerun = await ex!.input.make(ex!.input.parse(ex!.input.default));
    expect([...rerun()], renderer).toEqual([...ex!.factory()]);
  });
});
