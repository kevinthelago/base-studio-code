// The graph layout (#3224) — a pure, deterministic placement of node ids for the SVG GraphView. Split out
// of the renderer so the renderer file exports only its component (fast-refresh) and the layout is
// unit-testable on its own.

/** The svg viewBox is VIEW × VIEW; the layout circle has this radius. */
export const GRAPH_VIEW = 320;
const RADIUS = 116;

/** Place every id evenly on a circle, starting at the top (−90°). Pure + deterministic. */
export function circularLayout(ids: readonly string[]): Record<string, { x: number; y: number }> {
  const cx = GRAPH_VIEW / 2;
  const cy = GRAPH_VIEW / 2;
  const n = Math.max(1, ids.length);
  const pos: Record<string, { x: number; y: number }> = {};
  ids.forEach((id, i) => {
    const t = (i / n) * 2 * Math.PI - Math.PI / 2;
    pos[id] = { x: cx + RADIUS * Math.cos(t), y: cy + RADIUS * Math.sin(t) };
  });
  return pos;
}
