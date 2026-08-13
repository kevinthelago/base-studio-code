// Viewport culling geometry (#components-graph-culls-offscreen-nodes) — which world-space boxes can the
// user actually see, given a pan/zoom view and the size of the viewport that clips it.
//
// PURE ON PURPOSE. The decision "is this node worth mounting" is arithmetic over a transform and two
// rectangles; making it a function of numbers (rather than something that reads the DOM) is what lets the
// rule be tested exhaustively without a browser — and jsdom, which every test here runs in, has no layout
// at all, so a DOM-reading version would be untestable by construction.
//
// The caller measures the viewport in an EFFECT and passes the numbers in.
import type { GraphBox, GraphView } from "@/shared/ui/layouts/useGraphViewport";

/**
 * How much MORE than the visible area to keep mounted, as a multiple of the viewport, on every side.
 *
 * This is not a comfort setting — it is what makes culling compatible with the imperative pan (#4140).
 * A drag writes the world transform straight to the DOM and commits to React state only on mouseup, so
 * NOTHING re-renders mid-drag: the mounted set is frozen from the moment the drag starts until it ends.
 * A margin of one full viewport per side means a drag has to travel a whole screen before it can reach
 * space that was culled, and the commit that lands on mouseup re-fills it.
 *
 * The cost of raising it is real (area grows as the square: 1 ⇒ 9× the visible area), which is why it is
 * one rather than two.
 */
export const CULL_MARGIN_VIEWPORTS = 1;

/**
 * The world-space rectangle currently visible through a viewport of `vpW`×`vpH` screen px, expanded by
 * `margin` viewports on every side.
 *
 * Inverts the world layer's transform (`translate(tx,ty) scale(scale)`): a world point `w` is drawn at
 * screen `w * scale + t`, so the visible world span is `(0 - t)/scale` to `(vp - t)/scale`.
 *
 * Returns `null` for a viewport that has not been measured yet or a degenerate scale — the caller MUST
 * read that as "cull nothing" rather than "show nothing". Guessing a rect before the element has a size
 * is what would flash an empty graph on first paint.
 */
export function visibleWorldRect(
  view: GraphView,
  vpW: number,
  vpH: number,
  margin: number = CULL_MARGIN_VIEWPORTS,
): GraphBox | null {
  if (!(vpW > 0) || !(vpH > 0) || !(view.scale > 0)) return null;
  const w = vpW / view.scale;
  const h = vpH / view.scale;
  // `(0 - tx)` rather than `-tx`: the latter yields NEGATIVE zero for an unpanned view, and `-0` is a
  // value that compares equal to 0 with `===` but not with `Object.is`/`toEqual` — a trap for any caller
  // that memoizes or asserts on this rect. Geometry should not carry a sign on nothing.
  return {
    x: (0 - view.tx) / view.scale - w * margin,
    y: (0 - view.ty) / view.scale - h * margin,
    w: w * (1 + margin * 2),
    h: h * (1 + margin * 2),
  };
}

/**
 * Do two world-space boxes overlap at all? Edge-inclusive, so a node flush against the rect's boundary
 * counts as visible — the whole point of the margin is to be generous, and a node that is half a pixel
 * outside is one the user is about to pan onto.
 */
export function boxesIntersect(a: GraphBox, b: GraphBox): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

/**
 * Is a node at (`x`,`y`) sized `w`×`h` worth mounting, given the visible rect?
 *
 * A `null` rect means UNMEASURED, and everything is visible — see {@link visibleWorldRect}. That default
 * is deliberate and load-bearing: every failure mode of this module should render too much, never too
 * little, because rendering too much is the state we are already in and rendering too little is a blank
 * graph the user cannot tell from a crash.
 */
export function isNodeVisible(rect: GraphBox | null, x: number, y: number, w: number, h: number): boolean {
  return rect === null || boxesIntersect(rect, { x, y, w, h });
}
