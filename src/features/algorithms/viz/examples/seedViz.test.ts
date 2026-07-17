import { describe, it, expect } from "vitest";
import type { ArrayFrame } from "../../lib/trace";
import { KNOWLEDGE, implById } from "../../lib/knowledge";
import { vizExampleFromCode, vizForImpl } from "./registry";

// Guards the SHIPPED demonstrator (#3213): the seeded `sort.ts` carries a real `vizCode`, so a
// previously-missing-viz algorithm now animates from stored data. If the seed's vizCode string ever
// rots (bad JS, wrong shape), this fails loudly rather than silently blanking the visualization.
describe("seeded sort.ts visualization (#3213 demonstrator)", () => {
  const sort = implById(KNOWLEDGE, "sort.ts");

  it("ships a kind + a non-empty vizCode", () => {
    expect(sort).toBeDefined();
    expect(sort!.kind).toBe("sort");
    expect(sort!.vizCode?.trim()).toBeTruthy();
  });

  it("its stored vizCode compiles + runs the real sort (frames end sorted, swaps recorded)", () => {
    const viz = vizExampleFromCode(sort!.vizCode!)!;
    expect(viz).toBeDefined();
    expect(viz.renderers.array).toBeDefined();

    const frames = [...viz.factory()] as ArrayFrame[];
    expect(frames.some((f) => f.ops?.some((o) => o.op === "swap"))).toBe(true);
    const last = frames[frames.length - 1].data as number[];
    expect(last).toEqual([...last].sort((a, b) => a - b)); // ascending — the real algorithm sorted it
  });

  it("vizForImpl resolves sort.ts to its stored program (it was missing-viz before #3213)", () => {
    const viz = vizForImpl(sort!)!;
    expect(viz).toBeDefined();
    expect(viz.renderers.array).toBeDefined();
  });
});
