// Source instrumentation (#3250) — the AST step that gives each emitted op its provenance.
//
// The load-bearing assertion throughout is `source.slice(loc.start, loc.end) === "<the call>"`: it proves
// the recorded range really addresses the call it claims, rather than merely being a plausible number.
import { describe, it, expect } from "vitest";
import { instrumentVizCode, LOC_HOOK } from "./vizInstrument";

/** The substring a recorded range addresses — what the code column would highlight. */
const spanOf = (source: string, i: number): string => {
  const { locs } = instrumentVizCode(source);
  return source.slice(locs[i].start, locs[i].end);
};

describe("instrumentVizCode (#3250)", () => {
  it("records the exact range of each traced call", () => {
    const src = `({ run(a) { a.compare(0, 1); a.swap(0, 1); } })`;
    const { locs } = instrumentVizCode(src);
    expect(locs).toHaveLength(2);
    expect(spanOf(src, 0)).toBe("a.compare(0, 1)");
    expect(spanOf(src, 1)).toBe("a.swap(0, 1)");
  });

  it("wraps each traced call in the location hook, leaving the rest of the source verbatim", () => {
    const { code } = instrumentVizCode(`({ run(a) { a.swap(0, 1); } })`);
    expect(code).toBe(`({ run(a) { ${LOC_HOOK}(0,()=>a.swap(0, 1)); } })`);
  });

  it("records a 1-based line number for the readout", () => {
    const src = `({\n  run(a) {\n    a.swap(0, 1);\n  },\n})`;
    const { locs } = instrumentVizCode(src);
    expect(locs[0].line).toBe(3);
  });

  // THE case that rules out a text search: `.swap(` appears twice, in different branches. A regex locate
  // would find both and have to guess; the AST gives each its own range, so the highlight follows the
  // branch that actually ran.
  it("disambiguates the SAME op appearing in two branches (the quicksort case)", () => {
    const src = `({ run(a) { if (a.get(0) < 0) { a.swap(0, 1); } else { a.swap(1, 2); } } })`;
    const { locs } = instrumentVizCode(src);
    const spans = locs.map((l) => src.slice(l.start, l.end));
    expect(spans).toContain("a.swap(0, 1)");
    expect(spans).toContain("a.swap(1, 2)");
    // Distinct ranges — not two references to one "first match".
    const swaps = locs.filter((l) => src.slice(l.start, l.end).startsWith("a.swap"));
    expect(swaps[0].start).not.toBe(swaps[1].start);
  });

  it("handles NESTED traced calls — the inner call is wrapped inside the outer one", () => {
    const src = `({ run(a) { a.set(0, a.get(1)); } })`;
    const { code, locs } = instrumentVizCode(src);
    const spans = locs.map((l) => src.slice(l.start, l.end));
    expect(spans).toContain("a.set(0, a.get(1))"); // the outer call, whole
    expect(spans).toContain("a.get(1)"); // the inner call, on its own
    // The outer hook opens before the inner one and the inner closes first — proper nesting, which is
    // what lets the tracer's location STACK restore the outer range when the inner call returns.
    expect(code.indexOf(`${LOC_HOOK}(0,`)).toBeLessThan(code.indexOf(`${LOC_HOOK}(1,`));
  });

  it("derives the method set from the tracer classes — graph/scalar/stack verbs instrument too", () => {
    const src = `({ run(g) { g.visit("a"); g.relax("a", "b"); } })`;
    const spans = instrumentVizCode(src).locs.map((l) => src.slice(l.start, l.end));
    expect(spans).toEqual([`g.visit("a")`, `g.relax("a", "b")`]);
  });

  it("leaves a non-tracer method call alone", () => {
    const src = `({ run(a) { Math.max(1, 2); console.log("x"); } })`;
    expect(instrumentVizCode(src)).toEqual({ code: src, locs: [] });
  });

  it("does not confuse a COMPUTED member call for a tracer verb", () => {
    const src = `({ run(a) { a["swap"](0, 1); } })`;
    expect(instrumentVizCode(src).locs).toHaveLength(0);
  });

  // Degradation contract: a program that cannot be safely instrumented must still ANIMATE. Losing the
  // visualization to a highlighting feature would be a strictly worse outcome than losing the highlight.
  it("returns the source unchanged when it does not parse", () => {
    const src = `({ run(a) { a.swap(0, `;
    expect(instrumentVizCode(src)).toEqual({ code: src, locs: [] });
  });

  it("returns the source unchanged when it uses await/yield (arrow wrappers would change meaning)", () => {
    const src = `({ async run(a) { await Promise.resolve(); a.swap(0, 1); } })`;
    expect(instrumentVizCode(src)).toEqual({ code: src, locs: [] });
  });

  it("instruments a call inside an expression position without breaking it", () => {
    // `a.compare(...)` returns a value the program branches on — the wrapper must pass it through.
    const { code } = instrumentVizCode(`({ run(a) { if (a.compare(0, 1) <= 0) return; } })`);
    const d = new Function(LOC_HOOK, `"use strict"; return (${code});`)(
      (_id: number, call: () => unknown) => call(),
    ) as { run: (a: unknown) => void };
    const calls: string[] = [];
    d.run({ compare: () => (calls.push("compare"), 1) });
    expect(calls).toEqual(["compare"]);
  });
});
