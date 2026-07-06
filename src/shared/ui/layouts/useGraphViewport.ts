// Shared graph viewport (#2208, epic #2197 slice 2) — the canonical pan+zoom hook for every graph
// canvas (Org designer, Glance network, and future graphs). Pan+zoom is a CSS `transform:
// translate() scale()` on a "world" layer, with zoom-about-cursor. This replaced Org's older
// scroll-based usePanZoom; the transform model is cheaper (one composited layer) and keeps the point
// under the cursor fixed without depending on scroll geometry. Node-drag stays local to each canvas
// (it needs node identity + a live preview); this hook owns only the viewport.
//
// A press that starts on a `[data-node]` element does NOT pan — the node owns that gesture — so a
// canvas with draggable nodes (Org) and one with static nodes (Glance) share the same hook.
import { useCallback, useEffect, useRef, useState } from "react";
import { clamp } from "@/shared/lib/core/math";

export interface GraphView { tx: number; ty: number; scale: number }

export interface GraphViewportOpts {
  /** Min zoom. Default 0.28. */
  min?: number;
  /** Max zoom. Default 2.6. */
  max?: number;
  /** Viewport padding (px per side) left around the world when fitting. Default 70. */
  fitPad?: number;
  /** Cap on the scale `fit()` will zoom UP to (so a small graph isn't blown up). Default 1.05. */
  maxFitScale?: number;
}

/** The value returned by useGraphViewport — also the prop the GraphCanvas template + ZoomControls take. */
export interface GraphViewport {
  view: GraphView;
  /** Ref callback for the viewport (clipping) element — the wheel/pan target. */
  setVp: (el: HTMLDivElement | null) => void;
  /** Backdrop mousedown → pan. Bails on a `[data-node]` press (the node owns its gesture). */
  onCanvasDown: (e: React.MouseEvent) => void;
  /** Fit the whole world in the viewport and center it. */
  fit: () => void;
  /** Zoom by a factor around the viewport center (the +/- buttons). */
  zoomBy: (factor: number) => void;
  /** Set an absolute zoom around the viewport center (e.g. restoring a saved level). */
  zoomTo: (scale: number) => void;
  /** True during a pan-drag so the click that ends it doesn't select a node/edge. */
  dragMoved: React.MutableRefObject<boolean>;
  /** The `transform` style to spread onto the world layer. */
  worldTransform: React.CSSProperties;
}

/**
 * Zoom `v` to scale `ns` (clamped to [min,max]) while keeping the world point currently under the
 * viewport-relative point (mx,my) fixed on screen. Pure — exported for testing the anchor invariant.
 */
export function zoomAboutPoint(v: GraphView, ns: number, mx: number, my: number, min: number, max: number): GraphView {
  const nz = clamp(ns, min, max);
  const k = nz / v.scale;
  return { scale: nz, tx: mx - (mx - v.tx) * k, ty: my - (my - v.ty) * k };
}

/**
 * Fit a `w`×`h` world into a `cw`×`ch` viewport: the largest scale (clamped to [min, maxFitScale] and
 * then [min,max]) that leaves `fitPad` px per side, centered. Pure — exported for testing.
 */
export function fitView(w: number, h: number, cw: number, ch: number, min: number, max: number, fitPad: number, maxFitScale: number): GraphView {
  const s = clamp(Math.min((cw - fitPad * 2) / w, (ch - fitPad * 2) / h, maxFitScale), min, max);
  return { scale: s, tx: (cw - w * s) / 2, ty: (ch - h * s) / 2 };
}

export function useGraphViewport(world: { w: number; h: number }, opts: GraphViewportOpts = {}): GraphViewport {
  const min = opts.min ?? 0.28;
  const max = opts.max ?? 2.6;
  const fitPad = opts.fitPad ?? 70;
  const maxFitScale = opts.maxFitScale ?? 1.05;

  const [view, setView] = useState<GraphView>({ tx: 0, ty: 0, scale: 1 });
  const vpRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef(view);
  useEffect(() => { viewRef.current = view; }, [view]);
  const worldRef = useRef(world);
  useEffect(() => { worldRef.current = world; }, [world.w, world.h]);
  // Set true during a pan-drag so the click that ends it doesn't select a node/edge.
  const dragMoved = useRef(false);

  /** Zoom to `ns` keeping the world point under (mx,my) — viewport-relative client coords — fixed. */
  const zoomAbout = useCallback((ns: number, mx: number, my: number) => {
    setView((v) => zoomAboutPoint(v, ns, mx, my, min, max));
  }, [min, max]);

  /** Fit the whole world in the viewport and center it. */
  const fit = useCallback(() => {
    const el = vpRef.current;
    if (!el) return;
    const { w, h } = worldRef.current;
    setView(fitView(w, h, el.clientWidth, el.clientHeight, min, max, fitPad, maxFitScale));
  }, [min, max, fitPad, maxFitScale]);

  /** Zoom by a factor around the viewport center (the +/- buttons). */
  const zoomBy = useCallback((f: number) => {
    const el = vpRef.current;
    if (!el) return;
    zoomAbout(viewRef.current.scale * f, el.clientWidth / 2, el.clientHeight / 2);
  }, [zoomAbout]);

  /** Set an absolute zoom around the viewport center. */
  const zoomTo = useCallback((scale: number) => {
    const el = vpRef.current;
    if (!el) return;
    zoomAbout(scale, el.clientWidth / 2, el.clientHeight / 2);
  }, [zoomAbout]);

  // Wheel → zoom (native non-passive listener so we can preventDefault the page scroll).
  const onWheel = useCallback((e: WheelEvent) => {
    const el = vpRef.current;
    if (!el) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    zoomAbout(viewRef.current.scale * Math.exp(-e.deltaY * 0.0016), e.clientX - r.left, e.clientY - r.top);
  }, [zoomAbout]);

  /** Backdrop mousedown → pan (window-level move/up so a fast drag off the canvas still tracks). */
  const onCanvasDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("[data-node]")) return; // the node owns its own gesture
    const v = viewRef.current;
    const start = { x: e.clientX, y: e.clientY, tx: v.tx, ty: v.ty };
    dragMoved.current = false;
    if (vpRef.current) vpRef.current.style.cursor = "grabbing";
    const mm = (ev: MouseEvent) => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) dragMoved.current = true;
      setView((vv) => ({ ...vv, tx: start.tx + dx, ty: start.ty + dy }));
    };
    const mu = () => {
      if (vpRef.current) vpRef.current.style.cursor = "grab";
      window.removeEventListener("mousemove", mm);
      window.removeEventListener("mouseup", mu);
      // Clear on the next tick so the click handler (which fires after mouseup) can still read it.
      setTimeout(() => { dragMoved.current = false; }, 0);
    };
    window.addEventListener("mousemove", mm);
    window.addEventListener("mouseup", mu);
  }, []);

  // The wheel listener is attached HERE, from the ref callback, not from a mount effect: a canvas
  // can mount long after the hook (Design Studio's center pane starts on the Library view), and a
  // mount effect keyed on stable deps never re-runs when the element finally arrives — leaving
  // scroll-zoom permanently dead (#2454). Detaching from the previous element keeps repeated
  // mount/unmount/replace cycles free of leaked or doubled listeners.
  const setVp = useCallback((el: HTMLDivElement | null) => {
    const prev = vpRef.current;
    if (prev === el) return;
    if (prev) prev.removeEventListener("wheel", onWheel);
    vpRef.current = el;
    if (el) el.addEventListener("wheel", onWheel, { passive: false });
  }, [onWheel]);

  return {
    view, setVp, onCanvasDown, fit, zoomBy, zoomTo, dragMoved,
    worldTransform: { transform: `translate(${view.tx}px,${view.ty}px) scale(${view.scale})`, transformOrigin: "0 0" },
  };
}
