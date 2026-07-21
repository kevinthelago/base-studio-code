// The graph layout (#3224) — a pure, deterministic placement of node ids for the SVG GraphView. Split out
// of the renderer so the renderer file exports only its component (fast-refresh) and the layout is
// unit-testable on its own.

/** The svg viewBox is VIEW × VIEW; the layout circle has this radius. */
export const GRAPH_VIEW = 320;
const RADIUS = 116;

const PAD = 38; // inset for the coordinate layout so nodes don't touch the frame edge

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

/** A spatial layout from the nodes' own `x`/`y` (a road network, a grid) — scaled + padded to fit the
 *  viewBox. Returns `null` unless EVERY node has coordinates (so the caller can fall back to circular). */
export function coordinateLayout(
  nodes: readonly { id: string; x?: number; y?: number }[],
): Record<string, { x: number; y: number }> | null {
  if (nodes.length === 0 || !nodes.every((n) => n.x !== undefined && n.y !== undefined)) return null;
  const xs = nodes.map((n) => n.x as number);
  const ys = nodes.map((n) => n.y as number);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const spanX = Math.max(...xs) - minX || 1;
  const spanY = Math.max(...ys) - minY || 1;
  const inner = GRAPH_VIEW - 2 * PAD;
  const pos: Record<string, { x: number; y: number }> = {};
  for (const n of nodes) {
    pos[n.id] = {
      x: PAD + (((n.x as number) - minX) / spanX) * inner,
      y: PAD + (((n.y as number) - minY) / spanY) * inner,
    };
  }
  return pos;
}

/** The layout GraphView uses — the nodes' own coordinates when they all carry them (A*'s spatial graph),
 *  else an even circle. */
export function layoutFor(
  nodes: readonly { id: string; x?: number; y?: number }[],
): Record<string, { x: number; y: number }> {
  return coordinateLayout(nodes) ?? circularLayout(nodes.map((n) => n.id));
}
