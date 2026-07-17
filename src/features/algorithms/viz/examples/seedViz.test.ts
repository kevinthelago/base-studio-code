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
