// Viewport culling geometry (#components-graph-culls-offscreen-nodes).
//
// The invariant these protect is asymmetric: culling too MUCH is a blank graph the user cannot tell from
// a crash, while culling too LITTLE is merely the performance we already have. So every ambiguous case
// here is asserted to resolve toward RENDERING.
import { describe, it, expect } from "vitest";
import { visibleWorldRect, boxesIntersect, isNodeVisible, CULL_MARGIN_VIEWPORTS } from "./viewportCull";

const view = (tx: number, ty: number, scale: number) => ({ tx, ty, scale });

describe("visibleWorldRect", () => {
  it("inverts the world transform — at 1:1 with no pan it is exactly the viewport", () => {
    // margin 0 isolates the transform maths from the margin.
    expect(visibleWorldRect(view(0, 0, 1), 800, 600, 0)).toEqual({ x: 0, y: 0, w: 800, h: 600 });
  });

  it("moves the rect OPPOSITE the pan — panning the world right reveals world to the LEFT", () => {
    // The world layer is translated +200px, so the content that lands at screen x=0 is world x=-200.
    expect(visibleWorldRect(view(200, 0, 1), 800, 600, 0)).toEqual({ x: -200, y: 0, w: 800, h: 600 });
  });

  it("covers MORE world as you zoom out and less as you zoom in", () => {
    expect(visibleWorldRect(view(0, 0, 0.5), 800, 600, 0)).toEqual({ x: 0, y: 0, w: 1600, h: 1200 });
    expect(visibleWorldRect(view(0, 0, 2), 800, 600, 0)).toEqual({ x: 0, y: 0, w: 400, h: 300 });
  });

  it("expands by the margin on EVERY side — one viewport out becomes 3×3 viewports of area", () => {
    const r = visibleWorldRect(view(0, 0, 1), 800, 600, 1)!;
    expect(r).toEqual({ x: -800, y: -600, w: 2400, h: 1800 });
    // The visible area sits exactly in the middle of the margined rect.
    expect(r.x + r.w / 2).toBe(400);
    expect(r.y + r.h / 2).toBe(300);
  });

  it("ships a margin of a whole viewport — the imperative pan (#4140) freezes the mounted set mid-drag", () => {
    // Not a style preference: nothing re-renders between mousedown and mouseup, so the margin is the
    // only thing standing between a drag and un-mounted space.
    expect(CULL_MARGIN_VIEWPORTS).toBeGreaterThanOrEqual(1);
  });

  it("returns null — meaning CULL NOTHING — for an unmeasured viewport or a degenerate scale", () => {
    // The first paint runs before the element has a size. Guessing a rect there would flash an empty graph.
    expect(visibleWorldRect(view(0, 0, 1), 0, 600)).toBeNull();
    expect(visibleWorldRect(view(0, 0, 1), 800, 0)).toBeNull();
    expect(visibleWorldRect(view(0, 0, 0), 800, 600)).toBeNull();
    expect(visibleWorldRect(view(0, 0, -1), 800, 600)).toBeNull();
    expect(visibleWorldRect(view(0, 0, NaN), 800, 600)).toBeNull();
  });
});

describe("boxesIntersect", () => {
  const a = { x: 0, y: 0, w: 100, h: 100 };

  it("is true for overlap and containment, in both directions", () => {
    expect(boxesIntersect(a, { x: 50, y: 50, w: 100, h: 100 })).toBe(true);
    expect(boxesIntersect(a, { x: 10, y: 10, w: 10, h: 10 })).toBe(true);   // b inside a
    expect(boxesIntersect({ x: 10, y: 10, w: 10, h: 10 }, a)).toBe(true);   // a inside b — symmetric
  });

  it("is EDGE-INCLUSIVE — a node flush against the boundary is one you are about to pan onto", () => {
    expect(boxesIntersect(a, { x: 100, y: 0, w: 10, h: 10 })).toBe(true);
    expect(boxesIntersect(a, { x: 0, y: 100, w: 10, h: 10 })).toBe(true);
  });

  it("is false only when genuinely separated on an axis", () => {
    expect(boxesIntersect(a, { x: 101, y: 0, w: 10, h: 10 })).toBe(false);
    expect(boxesIntersect(a, { x: 0, y: 101, w: 10, h: 10 })).toBe(false);
    expect(boxesIntersect(a, { x: -20, y: 0, w: 10, h: 10 })).toBe(false);
  });
});

describe("isNodeVisible", () => {
  // The Design Studio node box.
  const NODE_W = 170, NODE_H = 54;

  it("mounts a node inside the rect and drops one outside it", () => {
    const rect = visibleWorldRect(view(0, 0, 1), 800, 600, 0)!;
    expect(isNodeVisible(rect, 10, 10, NODE_W, NODE_H)).toBe(true);
    expect(isNodeVisible(rect, 5000, 5000, NODE_W, NODE_H)).toBe(false);
  });

  it("mounts a node only PARTLY on screen — half a card is still a card you can see", () => {
    const rect = visibleWorldRect(view(0, 0, 1), 800, 600, 0)!;
    expect(isNodeVisible(rect, 800 - NODE_W / 2, 300, NODE_W, NODE_H)).toBe(true);
    expect(isNodeVisible(rect, -NODE_W / 2, 300, NODE_W, NODE_H)).toBe(true);
  });

  it("renders EVERYTHING when the rect is null — the safe direction for every failure mode", () => {
    expect(isNodeVisible(null, 0, 0, NODE_W, NODE_H)).toBe(true);
    expect(isNodeVisible(null, 1e9, 1e9, NODE_W, NODE_H)).toBe(true);
  });

  it("keeps a node a full viewport off-screen mounted, at the shipped margin", () => {
    // The property the margin exists for, stated as the drag it protects: 700px of pan (short of the
    // 800px viewport) must not reach un-mounted space.
    const rect = visibleWorldRect(view(0, 0, 1), 800, 600)!;
    expect(isNodeVisible(rect, 700, 300, NODE_W, NODE_H)).toBe(true);
    expect(isNodeVisible(rect, -700 - NODE_W, 300, NODE_W, NODE_H)).toBe(true);
    // …and something far beyond the margin is genuinely dropped, or culling would do nothing at all.
    expect(isNodeVisible(rect, 3000, 300, NODE_W, NODE_H)).toBe(false);
  });

  it("culls a realistic 459-node kit down to a working-zoom viewport", () => {
    // The shape of the real graph: a grid of 170×54 cards on ~200×90 pitch, 459 of them.
    const nodes = Array.from({ length: 459 }, (_, i) => ({ x: (i % 12) * 200, y: Math.floor(i / 12) * 90 }));
    const rect = visibleWorldRect(view(0, 0, 1), 1600, 900)!;
    const shown = nodes.filter((n) => isNodeVisible(rect, n.x, n.y, NODE_W, NODE_H)).length;
    expect(shown).toBeLessThan(nodes.length);
    // Sanity in the other direction — it must not cull so hard that the visible screen is empty.
    expect(shown).toBeGreaterThan(30);
  });

  it("culls NOTHING when the whole graph fits the viewport — the honest limit of this slice", () => {
    // Zoomed out to fit everything, every node genuinely IS visible, so culling cannot help. Pinned so
    // the limitation is recorded rather than discovered later as a disappointing measurement.
    const nodes = Array.from({ length: 459 }, (_, i) => ({ x: (i % 12) * 200, y: Math.floor(i / 12) * 90 }));
    const rect = visibleWorldRect(view(0, 0, 0.2), 1600, 900)!;
    const shown = nodes.filter((n) => isNodeVisible(rect, n.x, n.y, NODE_W, NODE_H)).length;
    expect(shown).toBe(nodes.length);
  });
});
