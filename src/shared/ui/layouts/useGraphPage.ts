// useGraphPage (#2719) — the small composition every graph PAGE hand-rolled: create a
// `useGraphViewport` and then re-fit it (deferred to the next animation frame) whenever the framed
// graph changes. It bundles the viewport plus the fit-on-key effect so a page only supplies the
// world, the fit key, and (optionally) the viewport options.
//
// ⚠️ THE FIT KEY MUST NOT BE THE POLLED GRAPH MODEL. Pass a STABLE value that changes ONLY when the
// graph should genuinely re-fit — a kit id, a drill target, a page name. Do NOT key on the graph
// `model`/`data` object itself: it gets a fresh reference on every data poll (liveness/fault/stall
// overlays recompute it), so keying on it re-fits every few seconds and wipes out the user's pan/zoom
// (#2554). `fit` reads the current world via a ref inside the viewport, so a deferred fit still
// frames the freshly-swapped graph even though the key, not the world, is the dependency.
//
// Bespoke fit logic stays in the page (Teams' saved-zoom restore, Glance's page-visibility guard,
// any centerOn focus move) — this hook owns only the plain rAF fit-on-key path.
import { useEffect } from "react";
import { useGraphViewport, type GraphViewport, type GraphViewportOpts } from "./useGraphViewport";

/**
 * Create a graph viewport for `world` and rAF-fit it on mount and whenever any value in `fitKey`
 * changes. Returns the full {@link GraphViewport} (pan/zoom controls, `fit`, `centerOn`, …).
 *
 * @param world  Nominal world box for the viewport.
 * @param fitKey Dependency list whose changes trigger a deferred re-fit — see the model-keying trap above.
 * @param opts   Viewport options (min/max zoom, fit padding, content bounds provider).
 */
export function useGraphPage(
  world: { w: number; h: number },
  fitKey: React.DependencyList,
  opts?: GraphViewportOpts,
): GraphViewport {
  const vp = useGraphViewport(world, opts);
  const { fit } = vp;
  useEffect(() => {
    const id = requestAnimationFrame(() => fit());
    return () => cancelAnimationFrame(id);
    // fit is stable per-viewport; the caller-supplied fitKey drives re-fits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...fitKey, fit]);
  return vp;
}
