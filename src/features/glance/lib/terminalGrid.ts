// The Glance terminal-grid layout model (#3361) — pure, React-free, so the grid's shape and ordering
// are unit-testable without rendering a terminal.
//
// WHY A GRID AT ALL: before #3361 exactly ONE node could be open, morphed into an oversized card at its
// own world coords (`GlanceStreamMorph`). Opening several that way would overlap them, and the parting
// machinery (`partAroundPanel`) could only make room for one panel. Terminals now live in the canvas
// DOCK (`GraphCanvas`'s `dock` slot, #2755) and tile into a grid, so N sessions are readable at once and
// no two can ever collide. The dock is outside the transformed world layer, so a terminal's size is
// independent of graph zoom — which is what makes several of them legible simultaneously. (The old
// in-graph morph had to force `zoomTo(1)` on open precisely because a world-space terminal is unreadable
// at graph zoom; that patch works for one panel and cannot work for a grid.)

/** The smallest a cell may get before the dock scrolls instead of shrinking further (px). */
export const MIN_CELL_H = 190;

/** A grid shape — `cols × rows` of terminal cells. */
export interface GridShape { cols: number; rows: number }

/**
 * The grid shape for `count` open sessions.
 *
 * Caps at 3 columns: a terminal narrower than ~a third of the canvas wraps its output badly, so past
 * six sessions we grow ROWS (and the dock scrolls) rather than adding a fourth, ever-narrower column.
 *
 * 0→0×0 · 1→1×1 · 2→2×1 · 3,4→2×2 · 5,6→3×2 · 7+→3×⌈n/3⌉
 */
export function gridShape(count: number): GridShape {
  if (count <= 0) return { cols: 0, rows: 0 };
  if (count === 1) return { cols: 1, rows: 1 };
  if (count === 2) return { cols: 2, rows: 1 };
  if (count <= 4) return { cols: 2, rows: 2 };
  const cols = 3;
  return { cols, rows: Math.ceil(count / cols) };
}

/** A node position, as much of `GNode` as the ordering needs. */
export interface GridNodePos { id: string; x: number; y: number }

/** Rows in the GRAPH are recovered by clustering y — a node within this many world px of the row's
 *  FIRST node joins that row. Sized to a node box plus its gap (`NH` 66 + spacing), so a layered
 *  graph's layers cluster cleanly without merging adjacent ones.
 *
 *  Deliberately a RELATIVE distance, not an absolute bucket (`floor(y / ROW_BAND)`): fixed buckets put
 *  two nodes a few px apart into different rows whenever they straddle a boundary, which is precisely
 *  the jitter this is meant to absorb. */
export const ROW_BAND = 110;

/**
 * Order open sessions by their node's position in the graph — banded by row (y), then left-to-right
 * (x) — so the grid reads as a PROJECTION of the graph rather than a stack in click order: open the
 * left-most and right-most streams and they land left and right.
 *
 * Ties (same band, same x) fall back to id so the order is total and stable — a React key order that
 * flickers between renders would remount terminals, and a remount tears down the PTY claim.
 *
 * Ids with no matching position sort LAST (a node that left the model mid-render), preserving their
 * relative order rather than throwing.
 */
export function orderByPosition(ids: readonly string[], positions: readonly GridNodePos[]): string[] {
  const byId = new Map(positions.map((p) => [p.id, p]));
  const known: GridNodePos[] = [];
  const unknown: string[] = [];
  for (const id of ids) {
    const p = byId.get(id);
    if (p) known.push(p); else unknown.push(id);
  }
  // Scan top-to-bottom; ties broken by x then id so the clustering pass itself is deterministic.
  known.sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));

  const out: string[] = [];
  let row: GridNodePos[] = [];
  let anchorY = 0;
  // Emit a completed row left-to-right.
  const flush = () => {
    row.sort((a, b) => a.x - b.x || a.id.localeCompare(b.id));
    for (const n of row) out.push(n.id);
    row = [];
  };
  for (const n of known) {
    if (row.length > 0 && n.y - anchorY > ROW_BAND) flush();
    if (row.length === 0) anchorY = n.y;
    row.push(n);
  }
  flush();
  return [...out, ...unknown];
}
