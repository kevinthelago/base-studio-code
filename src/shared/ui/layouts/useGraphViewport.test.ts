// useGraphViewport (#2208, epic #2197 slice 2) — the shared transform pan/zoom math. These cover the
// pure helpers behind the hook (the zoom-about-cursor anchor invariant, clamping, and fit centering)
// plus the wheel-listener lifecycle owned by the `setVp` ref callback (#2454).
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useGraphViewport, zoomAboutPoint, fitView, centerView, centeredView, fitBox, centeredBox, type GraphView } from "./useGraphViewport";

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

describe("centeredView (#2545)", () => {
  it("centers the world at an explicit scale", () => {
    // 800×600 world, 1000×600 viewport, scale 0.5 → world renders 400×300, centered.
    const v = centeredView(800, 600, 1000, 600, 0.5, 0.28, 2.6);
    expect(v.scale).toBe(0.5);
    expect(v.tx).toBe((1000 - 400) / 2); // 300
    expect(v.ty).toBe((600 - 300) / 2);  // 150
  });

  it("clamps the scale to [min,max]", () => {
    expect(centeredView(100, 100, 400, 400, 99, 0.4, 1.5).scale).toBe(1.5);
    expect(centeredView(100, 100, 400, 400, 0.01, 0.4, 1.5).scale).toBe(0.4);
  });

  it("keeps a tall world vertically on-screen where a zoom-about-center replay from origin would not (#2545)", () => {
    // The org bug: an 800-tall world in a 600-tall viewport, saved zoom 0.7. Restoring via zoomTo
    // replays zoomAboutPoint from the fresh mount's {0,0,1} origin about the viewport center...
    const W = 800, H = 800, CW = 900, CH = 600, saved = 0.7;
    const viaZoomTo = zoomAboutPoint({ tx: 0, ty: 0, scale: 1 }, saved, CW / 2, CH / 2, 0.28, 2.6);
    const worldBottomZoomTo = viaZoomTo.ty + H * viaZoomTo.scale;
    expect(worldBottomZoomTo).toBeGreaterThan(CH); // overflows the bottom (y+) — the reported bug

    // ...whereas centeredView frames it symmetrically, so top and bottom overhang are equal.
    const centered = centeredView(W, H, CW, CH, saved, 0.28, 2.6);
    const topGap = centered.ty;
    const bottomGap = CH - (centered.ty + H * centered.scale);
    expect(topGap).toBeCloseTo(bottomGap, 6);
  });
});

describe("centeredBox / fitBox (#2673 — frame the content box, not a nominal origin box)", () => {
  it("centeredBox offsets by the box origin so an off-origin box lands centered", () => {
    // A box at (100,200) sized 400×300 in a 1000×600 viewport at scale 1: its extent centers to
    // (600/2, 300/2) then shifts back by the origin. tx = (1000-400)/2 - 100 = 200; ty = (600-300)/2 - 200 = -50.
    const v = centeredBox({ x: 100, y: 200, w: 400, h: 300 }, 1000, 600, 1, 0.28, 2.6);
    expect(v.tx).toBeCloseTo(200, 6);
    expect(v.ty).toBeCloseTo(-50, 6);
    // The box's CENTER maps to the viewport center under the resulting view.
    expect((100 + 400 / 2) * v.scale + v.tx).toBeCloseTo(1000 / 2, 6);
    expect((200 + 300 / 2) * v.scale + v.ty).toBeCloseTo(600 / 2, 6);
  });

  it("centeredView is the box-at-origin case of centeredBox (unchanged behavior)", () => {
    expect(centeredView(800, 600, 1000, 600, 0.5, 0.28, 2.6))
      .toEqual(centeredBox({ x: 0, y: 0, w: 800, h: 600 }, 1000, 600, 0.5, 0.28, 2.6));
  });

  it("fitBox centers content regardless of where it sits — the org 'parked high' regression", () => {
    // Content biased into the upper part of a big canvas (like the org fleet ~978×536 in 1120×800): fitting
    // the CANVAS box leaves it high, but fitting the CONTENT box centers it. Its center lands at the
    // viewport center, so top and bottom margins are equal.
    const content = { x: 60, y: 48, w: 978, h: 536 };
    const CW = 900, CH = 600;
    const v = fitBox(content, CW, CH, 0.4, 1.5, 20, 1.5);
    const cx = content.x + content.w / 2, cy = content.y + content.h / 2;
    expect(cx * v.scale + v.tx).toBeCloseTo(CW / 2, 6);
    expect(cy * v.scale + v.ty).toBeCloseTo(CH / 2, 6);
    const topMargin = content.y * v.scale + v.ty;
    const bottomMargin = CH - ((content.y + content.h) * v.scale + v.ty);
    expect(topMargin).toBeCloseTo(bottomMargin, 6); // symmetric — not parked high
    expect(topMargin).toBeGreaterThan(0);           // fully on-screen (no top clipping)
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

// #3433 — the INITIAL framing. A page's own fit is a mount effect, so it frames whatever model exists at
// mount, and every graph page loads its data async: that is the EMPTY model. `buildGraph` sizes the world
// tightly around its content, so an empty graph is a small-but-valid box (Glance: 266x156) — `fitBox` caps
// at `maxFitScale` and centers THAT, parking world origin near the middle of the viewport. The real data
// then arrived, the world grew, and nothing re-framed it: the graph rendered from screen center off the
// bottom-right. #2554 had removed `model` from Glance's fit deps (correctly — a fresh model reference every
// status poll re-fit the graph constantly), which left nothing watching for the first real layout.
describe("useGraphViewport initial fit (#3433)", () => {
  const VW = 1600, VH = 900;
  /** A viewport element with a real size — jsdom reports 0, which would make every fit degenerate. */
  const sizedEl = (w = VW, h = VH) => {
    const el = document.createElement("div");
    Object.defineProperty(el, "clientWidth", { value: w, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: h, configurable: true });
    return el;
  };
  /** Let the effect's requestAnimationFrame land. */
  const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };

  const mount = async (w: number, h: number) => {
    const r = renderHook(({ world }) => useGraphViewport(world), { initialProps: { world: { w, h } } });
    act(() => r.result.current.setVp(sizedEl()));
    await flush();
    return r;
  };

  it("re-frames when the data lands and the world grows (the regression)", async () => {
    const { result, rerender } = await mount(266, 156);   // the empty Glance model
    // Framed the empty box: capped at maxFitScale, world origin parked near the viewport middle — which is
    // exactly why node #1 (world 70,70) rendered dead center.
    expect(result.current.view.scale).toBeCloseTo(1.05, 6);
    expect(result.current.view.tx).toBeGreaterThan(VW / 3);

    rerender({ world: { w: 1000, h: 2600 } });            // …the real projects arrive
    await flush();
    expect(result.current.view).toEqual(fitView(1000, 2600, VW, VH, 0.28, 2.6, 70, 1.05));
    // Height constrains, so the content now sits one fitPad from the top rather than mid-screen.
    expect(result.current.view.ty).toBeCloseTo(70, 6);
  });

  it("does NOT re-fit when the model re-renders at the SAME world size (#2554 preserved)", async () => {
    // A status poll hands back a fresh model object every few seconds but moves no node, so the world
    // dimensions are identical. Depending on the model reference here is what wiped the user's pan/zoom.
    const { result, rerender } = await mount(1000, 2600);
    act(() => result.current.centerOn(500, 1300));        // programmatic move, not a user gesture
    const parked = result.current.view;
    rerender({ world: { w: 1000, h: 2600 } });            // new object, same numbers
    await flush();
    expect(result.current.view).toEqual(parked);
  });

  it("stops re-fitting once the USER has panned", async () => {
    const { result, rerender } = await mount(266, 156);
    act(() => result.current.panBy(120, -40));
    const moved = result.current.view;
    rerender({ world: { w: 1000, h: 2600 } });            // a layout change must not yank their viewport
    await flush();
    expect(result.current.view).toEqual(moved);
  });

  it("stops re-fitting once the USER has zoomed", async () => {
    const { result, rerender } = await mount(266, 156);
    const el = sizedEl();
    act(() => result.current.setVp(el));
    act(() => { wheel(el, { clientX: 400, clientY: 300 }); });
    const zoomed = result.current.view;
    rerender({ world: { w: 1000, h: 2600 } });
    await flush();
    expect(result.current.view).toEqual(zoomed);
  });

  it("an EXPLICIT fit still works after the user has taken over", async () => {
    // The drill in/out re-fit and the toolbar button call `fit()` directly — never gated on `userMoved`.
    const { result, rerender } = await mount(266, 156);
    act(() => result.current.panBy(200, 200));
    rerender({ world: { w: 1000, h: 2600 } });
    await flush();
    act(() => result.current.fit());
    expect(result.current.view).toEqual(fitView(1000, 2600, VW, VH, 0.28, 2.6, 70, 1.05));
  });
});

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

  it("zoomToCentered is a no-op before the viewport mounts, then centers the world at the saved scale (#2545)", () => {
    const { result } = renderHook(() => useGraphViewport({ w: 800, h: 800 }, { min: 0.4, max: 1.5 }));
    // No viewport element yet → the restore call must not move the view (stays at the origin).
    act(() => result.current.zoomToCentered(0.7));
    expect(result.current.view).toEqual({ tx: 0, ty: 0, scale: 1 });
    // Attached: jsdom clientWidth/Height are 0 → centeredView gives tx = (0 - w*s)/2 = -w*s/2.
    const el = document.createElement("div");
    act(() => result.current.setVp(el));
    act(() => result.current.zoomToCentered(0.7));
    expect(result.current.view.scale).toBe(0.7);
    expect(result.current.view.tx).toBe(-800 * 0.7 / 2);
    expect(result.current.view.ty).toBe(-800 * 0.7 / 2);
  });

  it("fit/zoomToCentered frame the contentBounds provider's box when given, not the world (#2673)", () => {
    const bounds = { x: 100, y: 0, w: 200, h: 200 };
    const { result } = renderHook(() => useGraphViewport({ w: 800, h: 800 }, { min: 0.4, max: 1.5, contentBounds: () => bounds }));
    const el = document.createElement("div"); // jsdom clientWidth/Height = 0
    act(() => result.current.setVp(el));
    act(() => result.current.zoomToCentered(0.7));
    // centeredBox(bounds, 0, 0, 0.7): tx = -bounds.w·s/2 - bounds.x·s ; ty = -bounds.h·s/2 - bounds.y·s.
    expect(result.current.view.scale).toBe(0.7);
    expect(result.current.view.tx).toBeCloseTo(-200 * 0.7 / 2 - 100 * 0.7, 6); // -140, not the world's -280
    expect(result.current.view.ty).toBeCloseTo(-200 * 0.7 / 2 - 0, 6);         // -70
  });

  it("falls back to the world box when the contentBounds provider returns null (#2673)", () => {
    const { result } = renderHook(() => useGraphViewport({ w: 800, h: 800 }, { min: 0.4, max: 1.5, contentBounds: () => null }));
    const el = document.createElement("div");
    act(() => result.current.setVp(el));
    act(() => result.current.zoomToCentered(0.7));
    expect(result.current.view.tx).toBe(-800 * 0.7 / 2); // world box, exactly as the #2545 path
  });

  it("panBy translates the view by a raw screen-space delta, keeping zoom (#3190)", () => {
    // The externally-driven pan (an iframe forwarding a non-interactive drag): no mousedown of the
    // viewport's own, so onCanvasDown never fires — panBy nudges tx/ty directly by the screen delta.
    const { result } = renderHook(() => useGraphViewport({ w: 1000, h: 1000 }));
    const el = document.createElement("div");
    act(() => result.current.setVp(el));
    act(() => result.current.zoomBy(1.4)); // pan must be independent of the current zoom
    const before = result.current.view;
    expect(before.scale).not.toBe(1); // sanity: we're panning at a non-unit zoom
    act(() => result.current.panBy(30, -12));
    expect(result.current.view.scale).toBe(before.scale);     // zoom untouched
    expect(result.current.view.tx).toBe(before.tx + 30);      // screen px map 1:1 (translate applied after scale)
    expect(result.current.view.ty).toBe(before.ty - 12);
    // Deltas accumulate across a drag's successive moves.
    act(() => result.current.panBy(-5, 4));
    expect(result.current.view.tx).toBe(before.tx + 25);
    expect(result.current.view.ty).toBe(before.ty - 8);
  });

  it("zoomAtClient zooms about a PAGE point, keeping the world point under it fixed (#3190)", () => {
    // The forwarded-wheel path: the host is handed the cursor's PAGE coords and converts them to
    // viewport-relative via the live rect (jsdom rect is at 0,0 → page == viewport-relative). The world
    // point under the cursor must map to the SAME screen position before and after — the anchor invariant.
    const { result } = renderHook(() => useGraphViewport({ w: 1000, h: 1000 }, { min: 0.2, max: 5 }));
    const el = document.createElement("div"); // jsdom getBoundingClientRect → {left:0, top:0}
    act(() => result.current.setVp(el));
    act(() => result.current.panBy(-40, 15)); // start from a panned view so tx/ty aren't trivially 0
    const cx = 300, cy = 200;
    const before = result.current.view;
    const worldX = (cx - before.tx) / before.scale, worldY = (cy - before.ty) / before.scale;
    act(() => result.current.zoomAtClient(1.5, cx, cy));
    const after = result.current.view;
    expect(after.scale).toBeCloseTo(before.scale * 1.5, 6);            // scaled by the factor
    expect(worldX * after.scale + after.tx).toBeCloseTo(cx, 6);        // point under the cursor held fixed
    expect(worldY * after.scale + after.ty).toBeCloseTo(cy, 6);
  });

  it("zoomAtClient is a no-op before the viewport mounts, and clamps the scale to [min,max] (#3190)", () => {
    const { result } = renderHook(() => useGraphViewport({ w: 1000, h: 1000 }, { min: 0.4, max: 1.5 }));
    act(() => result.current.zoomAtClient(2, 10, 10));   // no viewport element yet → no move
    expect(result.current.view).toEqual({ tx: 0, ty: 0, scale: 1 });
    const el = document.createElement("div");
    act(() => result.current.setVp(el));
    act(() => result.current.zoomAtClient(99, 10, 10));  // way past max
    expect(result.current.view.scale).toBe(1.5);
    act(() => result.current.zoomAtClient(0.001, 10, 10)); // way past min
    expect(result.current.view.scale).toBe(0.4);
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

// #3433 — a page that mounts HIDDEN (a background tab) reports 0x0, and fitting against that would set a
// degenerate transform the user then sees on switching to it.
describe("useGraphViewport initial fit skips an unmeasurable viewport (#3433)", () => {
  const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };

  it("leaves the view untouched while the element has no size", async () => {
    const { result } = renderHook(({ world }) => useGraphViewport(world), { initialProps: { world: { w: 1000, h: 2600 } } });
    act(() => result.current.setVp(document.createElement("div"))); // jsdom: clientWidth/Height are 0
    await flush();
    expect(result.current.view).toEqual({ tx: 0, ty: 0, scale: 1 }); // the untouched initial state
  });
});
