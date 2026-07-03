// Canvas pan + zoom (#2199) — the interaction layer over the org canvas. Wheel zooms toward the cursor;
// dragging the background pans (by scrolling the container). Node-drag lives in OrgCanvas (it needs the
// node identity + a live preview); this hook owns the viewport. The zoom math is kept anchor-correct so
// the point under the cursor stays fixed — which requires the stage to be top-left aligned (no
// margin:auto centering), so scroll offset maps linearly to design-space coordinates.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { CANVAS_W, CANVAS_H, clampZoom } from "./orgLayout";

interface PanZoomOpts { initial?: number; min?: number; max?: number }

export function usePanZoom(ref: React.RefObject<HTMLDivElement | null>, opts: PanZoomOpts = {}) {
  const min = opts.min ?? 0.4;
  const max = opts.max ?? 1.5;
  const [zoom, setZoomState] = useState(opts.initial ?? 0.62);
  // Mirror zoom into a ref so the (stable) wheel/zoom callbacks read the latest value without being
  // re-created each zoom tick. Synced in an effect (never written during render).
  const zoomRef = useRef(zoom);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  // A scroll target computed alongside a zoom change, applied AFTER the DOM reflows to the new size.
  const pendingScroll = useRef<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pendingScroll.current) {
      el.scrollLeft = pendingScroll.current.left;
      el.scrollTop = pendingScroll.current.top;
      pendingScroll.current = null;
    }
  });

  /** Set zoom while keeping the design-space point under (cx,cy) — client coords relative to the
   *  container — fixed on screen. */
  const setZoomAt = useCallback((next: number, cx: number, cy: number) => {
    const el = ref.current;
    if (!el) return;
    const z = zoomRef.current;
    const nz = clampZoom(next, min, max);
    if (nz === z) return;
    const contentX = (el.scrollLeft + cx) / z;
    const contentY = (el.scrollTop + cy) / z;
    pendingScroll.current = { left: contentX * nz - cx, top: contentY * nz - cy };
    setZoomState(+nz.toFixed(3));
  }, [ref, min, max]);

  /** Zoom by a factor around the viewport center (the +/- buttons). */
  const zoomBy = useCallback((factor: number) => {
    const el = ref.current;
    if (!el) return;
    setZoomAt(zoomRef.current * factor, el.clientWidth / 2, el.clientHeight / 2);
  }, [ref, setZoomAt]);

  /** Fit the whole design space in the viewport and center it. */
  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const z = clampZoom(Math.min((el.clientWidth - 40) / CANVAS_W, (el.clientHeight - 40) / CANVAS_H), min, max);
    pendingScroll.current = { left: (CANVAS_W * z - el.clientWidth) / 2, top: (CANVAS_H * z - el.clientHeight) / 2 };
    setZoomState(+z.toFixed(3));
  }, [ref, min, max]);

  // Wheel → zoom. A native non-passive listener so we can preventDefault the page/container scroll.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setZoomAt(zoomRef.current * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ref, setZoomAt]);

  // Background drag → pan (scroll). Node presses stop propagation, so this only fires on the backdrop.
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const onBackgroundPointerDown = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("[data-node]")) return; // the node owns its own gesture
    const el = ref.current;
    if (!el) return;
    pan.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    el.setPointerCapture?.(e.pointerId);
    el.style.cursor = "grabbing";
  }, [ref]);
  const onBackgroundPointerMove = useCallback((e: React.PointerEvent) => {
    const p = pan.current, el = ref.current;
    if (!p || !el) return;
    el.scrollLeft = p.left - (e.clientX - p.x);
    el.scrollTop = p.top - (e.clientY - p.y);
  }, [ref]);
  const onBackgroundPointerUp = useCallback((e: React.PointerEvent) => {
    const el = ref.current;
    if (el) { el.releasePointerCapture?.(e.pointerId); el.style.cursor = ""; }
    pan.current = null;
  }, [ref]);

  return { zoom, setZoom: setZoomState, setZoomAt, zoomBy, fit, onBackgroundPointerDown, onBackgroundPointerMove, onBackgroundPointerUp };
}
