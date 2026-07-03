// Transform-based graph viewport (#2206) — pan + zoom via a CSS `transform: translate() scale()` on a
// "world" layer, with zoom-about-cursor. Ported from the spec (Glance Network); this is the cleaner
// approach the epic (#2205) adopts as the shared viewport (slice 2 factors it out + retrofits the Org
// canvas off its scroll-based usePanZoom). Drag the backdrop to pan; wheel to zoom toward the cursor.
import { useCallback, useEffect, useRef, useState } from "react";

interface View { tx: number; ty: number; scale: number }
const MIN = 0.28, MAX = 2.6;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export function useGraphViewport(world: { w: number; h: number }) {
  const [view, setView] = useState<View>({ tx: 0, ty: 0, scale: 1 });
  const vpRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef(view);
  useEffect(() => { viewRef.current = view; }, [view]);
  const worldRef = useRef(world);
  useEffect(() => { worldRef.current = world; }, [world.w, world.h]);
  // Set true during a pan-drag so the click that ends it doesn't select a node/edge.
  const dragMoved = useRef(false);

  /** Zoom to `ns` keeping the world point under (mx,my) — viewport-relative client coords — fixed. */
  const zoomAbout = useCallback((ns: number, mx: number, my: number) => {
    setView((v) => {
      const nz = clamp(ns, MIN, MAX);
      const k = nz / v.scale;
      return { scale: nz, tx: mx - (mx - v.tx) * k, ty: my - (my - v.ty) * k };
    });
  }, []);

  /** Fit the whole world in the viewport and center it. */
  const fit = useCallback(() => {
    const el = vpRef.current;
    if (!el) return;
    const { w, h } = worldRef.current;
    const pad = 70;
    const s = Math.min((el.clientWidth - pad * 2) / w, (el.clientHeight - pad * 2) / h, 1.05);
    setView({ scale: s, tx: (el.clientWidth - w * s) / 2, ty: (el.clientHeight - h * s) / 2 });
  }, []);

  /** Zoom by a factor around the viewport center (the +/- buttons). */
  const zoomBy = useCallback((f: number) => {
    const el = vpRef.current;
    if (!el) return;
    zoomAbout(viewRef.current.scale * f, el.clientWidth / 2, el.clientHeight / 2);
  }, [zoomAbout]);

  // Wheel → zoom (native non-passive listener so we can preventDefault the page scroll).
  useEffect(() => {
    const el = vpRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAbout(viewRef.current.scale * Math.exp(-e.deltaY * 0.0016), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAbout]);

  /** Backdrop mousedown → pan (window-level move/up so a fast drag off the canvas still tracks). */
  const onCanvasDown = useCallback((e: React.MouseEvent) => {
    const v = viewRef.current;
    const start = { x: e.clientX, y: e.clientY, tx: v.tx, ty: v.ty, moved: false };
    dragMoved.current = false;
    if (vpRef.current) vpRef.current.style.cursor = "grabbing";
    const mm = (ev: MouseEvent) => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) { start.moved = true; dragMoved.current = true; }
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

  const setVp = useCallback((el: HTMLDivElement | null) => { vpRef.current = el; }, []);

  return {
    view,
    setVp,
    onCanvasDown,
    fit,
    zoomBy,
    dragMoved,
    worldTransform: { transform: `translate(${view.tx}px,${view.ty}px) scale(${view.scale})`, transformOrigin: "0 0" as const },
  };
}
