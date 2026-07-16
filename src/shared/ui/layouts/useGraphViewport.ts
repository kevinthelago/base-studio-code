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

/** A design-space box (top-left + size) — the content bounds a graph frames on fit/restore. */
export interface GraphBox { x: number; y: number; w: number; h: number }

export interface GraphViewportOpts {
  /** Min zoom. Default 0.28. */
  min?: number;
  /** Max zoom. Default 2.6. */
  max?: number;
  /** Viewport padding (px per side) left around the world when fitting. Default 70. */
  fitPad?: number;
  /** Cap on the scale `fit()` will zoom UP to (so a small graph isn't blown up). Default 1.05. */
  maxFitScale?: number;
  /** Optional provider of the ACTUAL content bounding box (design-space), read live at fit/restore time.
   *  When set, `fit()` and `zoomToCentered()` frame THIS box instead of the nominal world — so a graph
   *  whose nodes fill only part of (or overflow) the world box is still centered on the nodes, not on
   *  empty canvas (#2673). Return null to fall back to the world box (e.g. an empty graph). */
  contentBounds?: () => GraphBox | null;
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
  /** Pan so world point (wx,wy) sits at the viewport center, KEEPING the current zoom — the
   *  least-disruptive "focus this node" move (Design Studio AI live-focus, #2525). No-op before the
   *  viewport element mounts. */
  centerOn: (wx: number, wy: number) => void;
  /** Zoom by a factor around the viewport center (the +/- buttons). */
  zoomBy: (factor: number) => void;
  /** Set an absolute zoom around the viewport center (e.g. Glance's zoom-to-100% snap). */
  zoomTo: (scale: number) => void;
  /** Set an absolute zoom with the world re-centered — the correct "restore a saved zoom" move, since
   *  it never depends on the pre-restore pan (which is the origin on a fresh mount). No-op before the
   *  viewport element mounts. (#2545) */
  zoomToCentered: (scale: number) => void;
  /** True during a pan-drag so the click that ends it doesn't select a node/edge. */
  dragMoved: React.MutableRefObject<boolean>;
  /** Pan by a screen-space delta (px) — for a pan gesture driven from OUTSIDE the viewport element
   *  (e.g. an iframe forwarding a non-interactive drag, #3190), where `onCanvasDown` never sees a
   *  mousedown of its own. */
  panBy: (dx: number, dy: number) => void;
  /** Zoom by `factor` (scale × factor, clamped) about a PAGE point (clientX,clientY) — for a wheel gesture
   *  forwarded from OUTSIDE the viewport (#3190). Same math as the native wheel: converts the page point to
   *  viewport-relative via the live bounding rect, so the anchor is exact regardless of the forwarder's
   *  own geometry. */
  zoomAtClient: (factor: number, clientX: number, clientY: number) => void;
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
 * Center a box `b` (design-space {x,y,w,h}) in a `cw`×`ch` viewport at an explicit `scale` (clamped to
 * [min,max]). Pure — exported for testing. Framing goes through here so the box's OWN extent is centered
 * and its origin offset out — i.e. the graph is centered on where its content actually is (#2673), not on
 * a nominal box pinned at the origin (which parked the org graph high / clipped it at the top).
 */
export function centeredBox(b: GraphBox, cw: number, ch: number, scale: number, min: number, max: number): GraphView {
  const s = clamp(scale, min, max);
  return { scale: s, tx: (cw - b.w * s) / 2 - b.x * s, ty: (ch - b.h * s) / 2 - b.y * s };
}

/**
 * Fit a box `b` into a `cw`×`ch` viewport: the largest scale (clamped to [min, maxFitScale] then
 * [min,max]) that leaves `fitPad` px per side, centered on the box. Pure — exported for testing.
 */
export function fitBox(b: GraphBox, cw: number, ch: number, min: number, max: number, fitPad: number, maxFitScale: number): GraphView {
  const s = Math.min((cw - fitPad * 2) / b.w, (ch - fitPad * 2) / b.h, maxFitScale);
  return centeredBox(b, cw, ch, s, min, max);
}

/** Center a `w`×`h` world — the box-at-origin case of {@link centeredBox}. Kept for callers that frame
 *  the nominal world (Glance) + the #2545 restore tests. */
export function centeredView(w: number, h: number, cw: number, ch: number, scale: number, min: number, max: number): GraphView {
  return centeredBox({ x: 0, y: 0, w, h }, cw, ch, scale, min, max);
}

/** Fit a `w`×`h` world — the box-at-origin case of {@link fitBox}. */
export function fitView(w: number, h: number, cw: number, ch: number, min: number, max: number, fitPad: number, maxFitScale: number): GraphView {
  return fitBox({ x: 0, y: 0, w, h }, cw, ch, min, max, fitPad, maxFitScale);
}

/**
 * Pan a `v.scale`d world so world point (wx,wy) sits at the center of a `cw`×`ch` viewport, keeping
 * `v.scale` unchanged. Pure — the least-disruptive "focus this node" move (#2525). Exported for testing.
 */
export function centerView(v: GraphView, cw: number, ch: number, wx: number, wy: number): GraphView {
  return { scale: v.scale, tx: cw / 2 - wx * v.scale, ty: ch / 2 - wy * v.scale };
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
  // Latest content-bounds provider (read live at fit/restore time). Seeded from the first render and
  // refreshed every commit — this hook is called before the consumer's own effects, so the ref is current
  // before a mount/org-change restore effect reads it (#2673).
  const boundsRef = useRef(opts.contentBounds);
  useEffect(() => { boundsRef.current = opts.contentBounds; });
  // Set true during a pan-drag so the click that ends it doesn't select a node/edge.
  const dragMoved = useRef(false);

  /** The box to frame: the live content bounds when a provider gives them, else the nominal world. */
  const frameBox = (): GraphBox => boundsRef.current?.() ?? { x: 0, y: 0, ...worldRef.current };

  /** Zoom to `ns` keeping the world point under (mx,my) — viewport-relative client coords — fixed. */
  const zoomAbout = useCallback((ns: number, mx: number, my: number) => {
    setView((v) => zoomAboutPoint(v, ns, mx, my, min, max));
  }, [min, max]);

  /** Fit the content (or the world, absent a content-bounds provider) in the viewport and center it. */
  const fit = useCallback(() => {
    const el = vpRef.current;
    if (!el) return;
    setView(fitBox(frameBox(), el.clientWidth, el.clientHeight, min, max, fitPad, maxFitScale));
  }, [min, max, fitPad, maxFitScale]);

  /** Pan world point (wx,wy) to the viewport center, keeping the current zoom (#2525). */
  const centerOn = useCallback((wx: number, wy: number) => {
    const el = vpRef.current;
    if (!el) return;
    setView((v) => centerView(v, el.clientWidth, el.clientHeight, wx, wy));
  }, []);

  /** Pan by a screen-space delta (px) — for a gesture forwarded from outside the viewport (#3190). */
  const panBy = useCallback((dx: number, dy: number) => {
    setView((v) => ({ ...v, tx: v.tx + dx, ty: v.ty + dy }));
  }, []);

  /** Zoom by `factor` about a PAGE point — a wheel forwarded from outside the viewport (#3190). Mirrors
   *  `onWheel`: convert the page point to viewport-relative via the live rect, then zoom about it. */
  const zoomAtClient = useCallback((factor: number, clientX: number, clientY: number) => {
    const el = vpRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    zoomAbout(viewRef.current.scale * factor, clientX - r.left, clientY - r.top);
  }, [zoomAbout]);

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

  /** Set an absolute zoom with the content (or world) re-centered (restoring a saved level, #2545/#2673). */
  const zoomToCentered = useCallback((scale: number) => {
    const el = vpRef.current;
    if (!el) return;
    setView(centeredBox(frameBox(), el.clientWidth, el.clientHeight, scale, min, max));
  }, [min, max]);

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
    view, setVp, onCanvasDown, fit, centerOn, zoomBy, zoomTo, zoomToCentered, dragMoved, panBy, zoomAtClient,
    worldTransform: { transform: `translate(${view.tx}px,${view.ty}px) scale(${view.scale})`, transformOrigin: "0 0" },
  };
}
