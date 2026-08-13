// useVisibleRect (#components-graph-culls-offscreen-nodes) — the live world-space rectangle a graph page
// can currently see, for mounting only the nodes inside it.
//
// WHEN IT RECOMPUTES, AND WHY THAT LIST IS SHORT. Panning is IMPERATIVE (#4140): the drag writes the world
// layer's transform straight to the DOM and commits to React state only on mouseup, precisely so a pan does
// not re-render a 459-node graph per mouse event. Culling must not undo that, so this deliberately does NOT
// track the drag — the rect follows `vp.view`, which changes when the view COMMITS (pan end, zoom, fit).
// Everything in between is covered by the margin baked into `visibleWorldRect`.
//
// ONLY THE SIZE IS STATE. The rect is DERIVED during render from `view` + the measured viewport size, and
// the size is the one genuinely external value here — it changes when the window, the rail or the
// inspector is resized, none of which React knows about. Deriving instead of storing the whole rect is
// what keeps a view commit to ONE render: storing it would setState inside an effect on every commit and
// cascade a second render, which is the cost this hook exists to avoid paying.
import { useEffect, useMemo, useState } from "react";
import { visibleWorldRect } from "@/shared/lib/graph/viewportCull";
import type { GraphBox, GraphViewport } from "./useGraphViewport";

interface Size { w: number; h: number }

/**
 * The visible world rect for `vp`, or `null` while the viewport is unmeasured — which every consumer must
 * read as "cull nothing" (see `isNodeVisible`).
 *
 * `enabled: false` pins the result at `null` — the honest way for a page to turn culling off (during a
 * screenshot, say, or for a graph small enough that culling is pure overhead) without the caller having to
 * reimplement the render-everything default.
 */
export function useVisibleRect(vp: GraphViewport, enabled = true): GraphBox | null {
  const [size, setSize] = useState<Size | null>(null);
  const { view, vpEl } = vp;

  useEffect(() => {
    const el = vpEl.current;
    // No ResizeObserver (jsdom, an old shell) ⇒ never measured ⇒ culling stays off. Degrading to
    // "render everything" is the correct direction for a missing capability.
    if (!el || typeof ResizeObserver === "undefined") return;
    // observe() fires an initial callback with the current size, so the first measurement arrives
    // through the same path as every later one — no synchronous setState in the effect body, and so no
    // cascading render on mount.
    const ro = new ResizeObserver(() => {
      const next = { w: el.clientWidth, h: el.clientHeight };
      setSize((prev) => (prev && prev.w === next.w && prev.h === next.h ? prev : next));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [vpEl]);

  return useMemo(
    () => (enabled && size ? visibleWorldRect(view, size.w, size.h) : null),
    [enabled, size, view],
  );
}
