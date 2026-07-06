// useGraphViewport (#2208, epic #2197 slice 2) — the shared transform pan/zoom math. These cover the
// pure helpers behind the hook: the zoom-about-cursor anchor invariant, clamping, and fit centering.
import { describe, it, expect } from "vitest";
import { zoomAboutPoint, fitView, type GraphView } from "./useGraphViewport";

const V0: GraphView = { tx: 0, ty: 0, scale: 1 };

describe("zoomAboutPoint (#2208)", () => {
  it("keeps the world point under the cursor fixed on screen", () => {
    const mx = 300, my = 200;
    // The world point currently under the cursor (screen → world at the OLD view).
    const worldX = (mx - V0.tx) / V0.scale;
    const worldY = (my - V0.ty) / V0.scale;
    const v = zoomAboutPoint(V0, 2, mx, my, 0.28, 2.6);
    expect(v.scale).toBe(2);
    // That same world point must map back to the cursor under the NEW view.
    expect(worldX * v.scale + v.tx).toBeCloseTo(mx, 6);
    expect(worldY * v.scale + v.ty).toBeCloseTo(my, 6);
  });

  it("holds the anchor invariant from a panned + zoomed start", () => {
    const start: GraphView = { tx: -120, ty: 80, scale: 1.4 };
    const mx = 250, my = 175;
    const worldX = (mx - start.tx) / start.scale;
    const worldY = (my - start.ty) / start.scale;
    const v = zoomAboutPoint(start, 0.7, mx, my, 0.28, 2.6);
    expect(worldX * v.scale + v.tx).toBeCloseTo(mx, 6);
    expect(worldY * v.scale + v.ty).toBeCloseTo(my, 6);
  });

  it("clamps the target scale to [min,max]", () => {
    expect(zoomAboutPoint(V0, 99, 0, 0, 0.4, 1.5).scale).toBe(1.5);
    expect(zoomAboutPoint(V0, 0.01, 0, 0, 0.4, 1.5).scale).toBe(0.4);
    expect(zoomAboutPoint(V0, 0.9, 0, 0, 0.4, 1.5).scale).toBe(0.9);
  });
});

describe("fitView (#2208)", () => {
  it("scales the world to leave the padding and centers it", () => {
    // 1000-wide world in a 600-wide viewport, 50px pad per side → 500 usable → 0.5 scale.
    const v = fitView(1000, 1000, 600, 600, 0.28, 2.6, 50, 1.05);
    expect(v.scale).toBeCloseTo(0.5, 6);
    // Centered: (viewport - world*scale)/2 = (600 - 500)/2 = 50.
    expect(v.tx).toBeCloseTo(50, 6);
    expect(v.ty).toBeCloseTo(50, 6);
  });

  it("does not zoom a small world past maxFitScale", () => {
    const v = fitView(100, 100, 2000, 2000, 0.28, 2.6, 70, 1.05);
    expect(v.scale).toBe(1.05);
  });

  it("respects the min/max floor over the fit", () => {
    // A huge world would want a tiny scale, but min floors it.
    const v = fitView(10000, 10000, 400, 400, 0.4, 1.5, 20, 1.5);
    expect(v.scale).toBe(0.4);
  });
});
