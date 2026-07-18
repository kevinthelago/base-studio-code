import { describe, it, expect } from "vitest";
import type { ArrayFrame } from "../../lib/trace";
import { KNOWLEDGE, implById } from "../../lib/knowledge";
import { runVizProgram } from "./vizProgram";
import { resolveVizExample, programVizForImpl } from "./registry";

// Guards the SHIPPED demonstrator (#3213): the seeded `sort.ts` carries a real `vizCode` that OVERRIDES its
// in-app program (both animate a sort). If the seed's vizCode string ever rots (bad JS, wrong shape), this
// fails loudly rather than silently blanking the visualization. Run through the #3233 sandbox path.
describe("seeded sort.ts visualization (#3213 demonstrator)", () => {
  const sort = implById(KNOWLEDGE, "sort.ts");

  it("ships a kind + a non-empty vizCode", () => {
    expect(sort).toBeDefined();
    expect(sort!.kind).toBe("sort");
    expect(sort!.vizCode?.trim()).toBeTruthy();
  });

  it("its stored vizCode compiles + runs the real sort (frames end sorted, swaps recorded)", () => {
    const { datatype, frames } = runVizProgram(sort!.vizCode!);
    expect(datatype).toBe("array");
    expect((frames as ArrayFrame[]).some((f) => f.ops?.some((o) => o.op === "swap"))).toBe(true);
    const last = (frames[frames.length - 1] as ArrayFrame).data as number[];
    expect(last).toEqual([...last].sort((a, b) => a - b)); // ascending — the real algorithm sorted it
  });

  it("resolves through the sandbox to a renderable array example", async () => {
    const viz = (await resolveVizExample(sort!.vizCode!))!;
    expect(viz).toBeDefined();
    expect(viz.renderers.array).toBeDefined();
  });

  it("also has an in-app program under its base name (sort.ts → the `sort` program)", () => {
    // sort.ts is doubly covered: an in-app `sort` program AND its stored vizCode (which useVizForImpl
    // prefers). The program is what shows synchronously before the sandbox resolves the vizCode.
    expect(programVizForImpl({ id: "sort.ts", name: "sort" })?.renderers.array).toBeDefined();
  });
});

// The SHIPPED per-op highlighting (#3250). This is the one path a user actually sees: the seeded
// `sort.ts` vizCode → the sandbox → the stage's code column. It guards both halves — that the seed is
// still multi-line (a one-line program makes the column unreadable) and that its frames carry ranges
// that slice back out as real tracer calls.
describe("seeded sort.ts per-op source highlighting (#3250)", () => {
  const sort = implById(KNOWLEDGE, "sort.ts");

  it("ships a MULTI-LINE program, so the code column is readable", () => {
    expect(sort!.vizCode!.trim().split("\n").length).toBeGreaterThan(5);
  });

  it("every op-frame carries a range that slices out as the tracer call that emitted it", () => {
    const { frames, source } = runVizProgram(sort!.vizCode!);
    const stamped = frames.filter((f) => f.loc);
    expect(stamped.length).toBeGreaterThan(5); // a real trace, not one lucky frame

    for (const frame of stamped) {
      const span = source.slice(frame.loc!.start, frame.loc!.end);
      expect(span).toMatch(/^a\.\w+\(/); // e.g. `a.compare(j - 1, j)` — a call on the traced array
      // The range's reported line must be the line that span actually sits on.
      expect(source.slice(0, frame.loc!.start).split("\n").length).toBe(frame.loc!.line);
    }
  });

  it("highlights the compare and the swap as SEPARATE beats, though both are ops of one inner loop", () => {
    const { frames, source } = runVizProgram(sort!.vizCode!);
    const spans = frames.filter((f) => f.loc).map((f) => source.slice(f.loc!.start, f.loc!.end));
    expect(spans.some((s) => s.startsWith("a.compare("))).toBe(true);
    expect(spans.some((s) => s.startsWith("a.swap("))).toBe(true);
    // Per-op, not per-line: the compare and the swap are on different lines here, and each gets its own
    // beat — consecutive frames never share one range across two distinct ops.
    const compare = frames.find((f) => f.loc && source.slice(f.loc.start, f.loc.end).startsWith("a.compare("));
    const swap = frames.find((f) => f.loc && source.slice(f.loc.start, f.loc.end).startsWith("a.swap("));
    expect(compare!.loc!.start).not.toBe(swap!.loc!.start);
  });

  it("resolves through the sandbox with the source the ranges index into", async () => {
    const viz = (await resolveVizExample(sort!.vizCode!))!;
    expect(viz.source).toBe(sort!.vizCode!.trim());
  });
});
