// useGraphViewport (#2208, epic #2197 slice 2) — the shared transform pan/zoom math. These cover the
// pure helpers behind the hook (the zoom-about-cursor anchor invariant, clamping, and fit centering)
// plus the wheel-listener lifecycle owned by the `setVp` ref callback (#2454).
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useGraphViewport, zoomAboutPoint, fitView, centerView, type GraphView } from "./useGraphViewport";

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

describe("centerView (#2525)", () => {
  it("pans a world point to the viewport center, keeping the current zoom", () => {
    const v: GraphView = { tx: 0, ty: 0, scale: 2 };
    const r = centerView(v, 800, 600, 100, 50);
    expect(r.scale).toBe(2);            // zoom is untouched (least-disruptive focus)
    expect(r.tx).toBe(800 / 2 - 100 * 2); // 400 - 200 = 200
    expect(r.ty).toBe(600 / 2 - 50 * 2);  // 300 - 100 = 200
    // The centered world point maps back to the viewport center under the new view.
    expect(100 * r.scale + r.tx).toBe(400);
    expect(50 * r.scale + r.ty).toBe(300);
  });
});

// One wheel notch at deltaY -120 → scale × e^(120·0.0016) (the hook's zoom rate).
const NOTCH = Math.exp(120 * 0.0016);

const wheel = (el: HTMLElement, init: WheelEventInit = {}) =>
  el.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, cancelable: true, ...init }));

describe("useGraphViewport wheel listener lifecycle (#2454)", () => {
  it("zooms a viewport element attached AFTER the hook mounts", () => {
    // Regression: Design Studio mounts the hook while the center pane shows the Library view, so
    // the canvas element only arrives later. The old mount effect ran once against an empty ref
    // and never re-attached — scroll-zoom stayed permanently dead.
    const { result } = renderHook(() => useGraphViewport({ w: 1000, h: 1000 }));
    const el = document.createElement("div");
    act(() => result.current.setVp(el));
    let cancelled = false;
    act(() => { cancelled = !wheel(el, { clientX: 300, clientY: 200 }); });
    expect(result.current.view.scale).toBeCloseTo(NOTCH, 6);
    // Non-passive: the handler preventDefaults the page scroll.
    expect(cancelled).toBe(true);
  });

  it("keeps the world point under the cursor fixed across a wheel zoom", () => {
    const { result } = renderHook(() => useGraphViewport({ w: 1000, h: 1000 }));
    const el = document.createElement("div"); // jsdom rect at (0,0) → viewport coords = client coords
    act(() => result.current.setVp(el));
    const mx = 300, my = 200;
    const v0 = result.current.view;
    const worldX = (mx - v0.tx) / v0.scale, worldY = (my - v0.ty) / v0.scale;
    act(() => { wheel(el, { clientX: mx, clientY: my }); });
    const v = result.current.view;
    expect(worldX * v.scale + v.tx).toBeCloseTo(mx, 6);
    expect(worldY * v.scale + v.ty).toBeCloseTo(my, 6);
  });

  it("does not double the listener when setVp repeats the same element", () => {
    const { result } = renderHook(() => useGraphViewport({ w: 1000, h: 1000 }));
    const el = document.createElement("div");
    act(() => result.current.setVp(el));
    act(() => result.current.setVp(el));
    act(() => { wheel(el); });
    expect(result.current.view.scale).toBeCloseTo(NOTCH, 6); // exactly one zoom step, not two
  });

  it("detaches from a replaced element and follows the new one", () => {
    const { result } = renderHook(() => useGraphViewport({ w: 1000, h: 1000 }));
    const a = document.createElement("div");
    const b = document.createElement("div");
    act(() => result.current.setVp(a));
    act(() => result.current.setVp(b));
    act(() => { wheel(a); });
    expect(result.current.view.scale).toBe(1); // the old element is inert
    act(() => { wheel(b); });
    expect(result.current.view.scale).toBeCloseTo(NOTCH, 6);
  });

  it("detaches on unmount (setVp(null)) so the element stops zooming", () => {
    const { result } = renderHook(() => useGraphViewport({ w: 1000, h: 1000 }));
    const el = document.createElement("div");
    act(() => result.current.setVp(el));
    act(() => result.current.setVp(null));
    act(() => { wheel(el); });
    expect(result.current.view.scale).toBe(1);
  });

  it("centerOn pans the given world point toward the viewport center, keeping zoom (#2525)", () => {
    const { result } = renderHook(() => useGraphViewport({ w: 1000, h: 1000 }));
    // No-op before the viewport element mounts (no ref yet).
    act(() => result.current.centerOn(200, 100));
    expect(result.current.view).toEqual({ tx: 0, ty: 0, scale: 1 });
    // Attached: jsdom clientWidth/Height are 0 → center is (0,0); tx = 0 - wx*scale (scale 1).
    const el = document.createElement("div");
    act(() => result.current.setVp(el));
    act(() => result.current.centerOn(200, 100));
    expect(result.current.view.scale).toBe(1); // zoom untouched
    expect(result.current.view.tx).toBe(-200);
    expect(result.current.view.ty).toBe(-100);
  });
});
