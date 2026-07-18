// The Glance morph GRID (#3361, directional placement #3367) — pure, React-free geometry + placement
// for the in-graph terminal morphs, so the layout is unit-testable without rendering a terminal.
//
// THE MODEL: morphs stay IN the graph (a node grows into its live session in place — that is the whole
// point of the morph, #2534). What changes is that a morph no longer free-floats at its own node's
// coords, where two open morphs would sit on top of each other. Instead each occupies a discrete cell of
// a lattice, so non-overlap is guaranteed by construction rather than by a soft push-apart relaxation.
//
// THE FIRST OPENED NODE DEFINES THE GRID. Its morph lands exactly where a single morph lands today —
// centred on its own node — and that box becomes cell (0,0). The origin is derived from the ANCHOR NODE
// (an id) rather than frozen as raw coords, so the grid tracks the graph if the layout recomputes (the
// live-status overlays rebuild the model every poll).
//
// THE LATTICE IS SIGNED AND DIRECTIONAL (#3367). Cells extend every way from the anchor — (-1,0) is one
// cell LEFT, (0,-1) one cell UP — and a newly opened node takes the free cell whose direction from the
// anchor best matches ITS node's direction from the anchor node. So the grid reads as a spatial
// projection of the graph: open a node to the left of the anchor and its terminal opens to the LEFT.
// (Before #3367 cells were handed out row-major, so the second morph was always to the right and the
// fourth always wrapped below, no matter where their nodes actually sat.)
import type { MorphRect } from "./glancePush";
import { NW, NH } from "./glanceGraph";

/** A cell's DEFAULT size, in WORLD units (it renders at world-size × the current zoom). Matches the
 *  pre-grid single-morph card, so opening one node is visually unchanged. */
export const CELL_W = 760, CELL_H = 520;
/** Resize bounds for the shared cell (world units). A resize drives EVERY cell — a per-morph size would
 *  break the non-overlap guarantee the grid exists to provide. */
export const CELL_MIN_W = 380, CELL_MIN_H = 280, CELL_MAX_W = 1600, CELL_MAX_H = 1100;
/** Gutter between cells, world units — wide enough that two cards read as separate panels. */
export const GRID_GAP = 28;
/** How far out the placement search looks for a free cell. Ring 6 spans 169 cells — far past any
 *  plausible number of simultaneously open sessions, so this is a termination guard, not a cap. */
export const MAX_RING = 6;
/** How much a cell's score is docked per ring beyond the first — the compactness-vs-direction trade.
 *  At 0.35 a ring-1 cell at cos 0.71 (0.71) still beats a perfectly-aligned ring-2 cell (1.0 − 0.35 =
 *  0.65), so the block stays tight; but a ring-1 cell pointing the WRONG way (cos ≈ 0) loses to it, so a
 *  node never lands on the opposite side of the anchor from where it sits. */
export const RING_PENALTY = 0.35;

/** The shared cell size — mutated as one by any morph's resize handles. */
export interface CellSize { w: number; h: number }

export const DEFAULT_CELL: CellSize = { w: CELL_W, h: CELL_H };

/** A lattice position. SIGNED: a negative col is LEFT of the anchor, a negative row is ABOVE it. */
export interface GridCell { col: number; row: number }

/** Which node holds which cell. */
export interface MorphPlacement extends GridCell { nodeId: string }

/** As much of a node as the grid geometry needs. */
export interface GridAnchorNode { x: number; y: number }

/**
 * Cell (0,0)'s top-left, in world coords: the cell CENTRED on the anchor node — byte-identical to the
 * pre-grid morph's own box (`node.x + NW/2 - CARD_W/2`). This is what makes opening the first node look
 * exactly as it always has; the grid only becomes visible from the second morph on.
 */
export function gridOrigin(anchor: GridAnchorNode, cell: CellSize = DEFAULT_CELL): { x: number; y: number } {
  return { x: anchor.x + NW / 2 - cell.w / 2, y: anchor.y + NH / 2 - cell.h / 2 };
}

/** The world box of a lattice cell. Signed, so `col: -1` sits one full cell + gap to the LEFT. */
export function cellRect(anchor: GridAnchorNode, at: GridCell, cell: CellSize = DEFAULT_CELL): MorphRect {
  const o = gridOrigin(anchor, cell);
  return {
    left: o.x + at.col * (cell.w + GRID_GAP),
    top: o.y + at.row * (cell.h + GRID_GAP),
    w: cell.w,
    h: cell.h,
  };
}

/** Every cell at Chebyshev distance `r` from the origin — the square "ring" at radius r. Ring 0 is the
 *  origin itself; ring 1 is the eight neighbours. Deterministically ordered (by col, then row). */
export function ringCells(r: number): GridCell[] {
  if (r <= 0) return [{ col: 0, row: 0 }];
  const out: GridCell[] = [];
  for (let col = -r; col <= r; col++) {
    for (let row = -r; row <= r; row++) {
      if (Math.max(Math.abs(col), Math.abs(row)) === r) out.push({ col, row });
    }
  }
  return out;
}

/** How well a cell's direction from the origin matches the unit vector (ux,uy): the cosine of the angle
 *  between them, in [-1, 1]. The origin cell has no direction, so it scores 0. */
function alignment(at: GridCell, ux: number, uy: number): number {
  const len = Math.hypot(at.col, at.row);
  if (len === 0) return 0;
  return (at.col * ux + at.row * uy) / len;
}

const key = (at: GridCell) => `${at.col},${at.row}`;

/**
 * Place `nodeId` in the free cell that best matches `delta` — its node's world offset FROM THE ANCHOR
 * NODE. A node to the left of the anchor gets a cell to the left; one up-and-right gets an up-and-right
 * cell. This is what makes the grid a spatial projection of the graph rather than an arbitrary queue.
 *
 * Search runs ring by ring outward, so placement stays compact: within the first ring holding a free
 * cell, the best-aligned one wins. Two nodes on the same side therefore both land on that side — the
 * second takes the next-best cell there (a diagonal), never the opposite side.
 *
 * The FIRST placement is always the anchor itself at (0,0). Afterwards the search starts at ring 1, so a
 * centre freed by the anchor's own morph closing cannot swallow a node that clearly belongs to one side.
 * The one exception is a `delta` of zero — the anchor node itself re-opening — which takes (0,0) back.
 *
 * Placed morphs are NEVER moved: direction decides where a morph goes when it OPENS. Re-ranking every
 * morph on each open would make a terminal being read jump, which is worse than an imperfect
 * arrangement. Re-placing an already-placed node is a no-op.
 */
export function placeByDirection(
  placements: readonly MorphPlacement[],
  nodeId: string,
  delta: { dx: number; dy: number },
  maxRing: number = MAX_RING,
): MorphPlacement[] {
  if (placements.some((p) => p.nodeId === nodeId)) return placements.slice();
  if (placements.length === 0) return [{ nodeId, col: 0, row: 0 }];

  const taken = new Set(placements.map(key));
  const len = Math.hypot(delta.dx, delta.dy);

  // A zero delta means this IS the anchor node, re-opened after its own morph closed — it belongs at the
  // centre. Every other node starts at ring 1, so a freed centre never steals a directional placement.
  if (len === 0) {
    if (!taken.has(key({ col: 0, row: 0 }))) return [...placements, { nodeId, col: 0, row: 0 }];
    for (let r = 1; r <= maxRing; r++) {
      const free = ringCells(r).find((c) => !taken.has(key(c)));
      if (free) return [...placements, { nodeId, ...free }];
    }
    return placements.slice();
  }

  const ux = delta.dx / len, uy = delta.dy / len;
  // Score every free cell GLOBALLY rather than taking the first ring with a vacancy: staying on the
  // right SIDE matters more than staying close. With three nodes already open to the left, a fourth
  // left-hand node must spill further left (-2,0) rather than drop into a near-but-wrong cell below the
  // anchor — first-free-ring did exactly that, which is the #3367 bug in miniature.
  //
  // The penalty is tuned so a well-aligned neighbour still beats a perfectly-aligned distant cell (a
  // ring-1 cell at cos 0.71 scores 0.71, a ring-2 cell at cos 1.0 scores 0.65), keeping the block
  // compact, while a badly-aligned neighbour (cos ~0) loses to it.
  let best: { cell: GridCell; score: number } | null = null;
  for (let r = 1; r <= maxRing; r++) {
    for (const c of ringCells(r)) {
      if (taken.has(key(c))) continue;
      const score = alignment(c, ux, uy) - RING_PENALTY * (r - 1);
      if (!best
          || score > best.score + 1e-9
          // Deterministic tie-break, so the same graph always lays out the same way.
          || (Math.abs(score - best.score) <= 1e-9
              && (c.col < best.cell.col || (c.col === best.cell.col && c.row < best.cell.row)))) {
        best = { cell: c, score };
      }
    }
  }
  // Every ring out to maxRing is full — refuse rather than overlap. Unreachable in practice (169 cells).
  return best ? [...placements, { nodeId, ...best.cell }] : placements.slice();
}

/** Drop `nodeId`'s placement. The survivors keep their cells — closing one morph never moves another. */
export function releaseCell(placements: readonly MorphPlacement[], nodeId: string): MorphPlacement[] {
  return placements.filter((p) => p.nodeId !== nodeId);
}

/** The node ids currently holding a cell, in placement order. */
export function occupants(placements: readonly MorphPlacement[]): string[] {
  return placements.map((p) => p.nodeId);
}

/**
 * The bounding box of every open morph — the single region the graph parts around. Null when none are
 * open (so the neighbours snap back).
 *
 * Unions the boxes the morphs REPORT rather than deriving them from placements: a morph releases its box
 * the instant it starts collapsing, several hundred ms before it unmounts, so the graph parts back in
 * step with the shrink instead of lagging a full exit animation behind it.
 */
export function unionRects(rects: readonly MorphRect[]): MorphRect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.left + r.w));
  const bottom = Math.max(...rects.map((r) => r.top + r.h));
  return { left, top, w: right - left, h: bottom - top };
}

/** Clamp a proposed shared cell size to the resize bounds. */
export function clampCell(w: number, h: number): CellSize {
  return {
    w: Math.min(Math.max(w, CELL_MIN_W), CELL_MAX_W),
    h: Math.min(Math.max(h, CELL_MIN_H), CELL_MAX_H),
  };
}
