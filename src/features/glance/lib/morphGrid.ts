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
// THE LATTICE IS SIGNED (#3367). Cells extend every way from the anchor — (-1,0) is one cell LEFT,
// (0,-1) one cell UP.
//
// PLACEMENT IS UNIFORMITY-FIRST, DIRECTION SECOND (#3525). #3367 placed each node in the free cell whose
// direction from the anchor best matched its node's direction. That kept a lone node on its own side but
// let the block spread into a sparse, non-square arrangement — three left-hand nodes could sit in a
// 1×3 column with gaps rather than collapsing into a tight tile. A newly opened node now first looks for
// the cell that keeps the OPEN BLOCK most uniform — a compact, near-square rectangle with no interior
// holes — and only uses direction to break ties BETWEEN equally-compact cells. So the block still leans
// toward the side its nodes sit on (a left-heavy graph opens a left-leaning block), but it always reads
// as a tidy tile grid rather than a scatter. The trade is deliberate: an individual left-hand node may
// land in the anchor's own column when that is what completes the square, because a uniform block beats
// a strictly-sided but ragged one.
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
/** The most cells a compact block can be off a perfect square before direction stops mattering — unused
 *  as a tunable now that compactness is lexicographically primary (#3525); kept exported for callers/tests
 *  that referenced the old direction-vs-distance trade. */
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

/** The two numbers that make a placement UNIFORM (#3525), for the occupied set INCLUDING the candidate.
 *  Compared lexicographically, smaller = more uniform:
 *   1. `maxDim` — the longer side of the bounding box. Minimising it caps how far the block can stretch
 *      in any one direction, so N cells collapse toward a √N-square instead of a long strip.
 *   2. `holes` — empty cells inside that box (`area − filled`). With `maxDim` fixed, the fewest holes
 *      wins, so a candidate that fills a gap always beats one that opens the block up. */
function uniformity(cells: readonly GridCell[]): { maxDim: number; holes: number } {
  let minC = Infinity, maxC = -Infinity, minR = Infinity, maxR = -Infinity;
  for (const c of cells) {
    if (c.col < minC) minC = c.col;
    if (c.col > maxC) maxC = c.col;
    if (c.row < minR) minR = c.row;
    if (c.row > maxR) maxR = c.row;
  }
  const w = maxC - minC + 1, h = maxR - minR + 1;
  return { maxDim: Math.max(w, h), holes: w * h - cells.length };
}

/**
 * Place `nodeId` in the free cell that keeps the open block most UNIFORM, breaking ties by `delta` — its
 * node's world offset FROM THE ANCHOR NODE (#3525, was direction-first in #3367).
 *
 * For each free cell the candidate occupied set is scored by {@link uniformity} (compact, hole-free
 * first); among equally-uniform cells the one whose direction best matches `delta` wins, so the block
 * still leans toward the side its nodes sit on. This is what makes N morphs collapse into a tidy tile
 * grid (a 2×2, then 3×3, …) rather than the sparse strips direction-first could leave — while a
 * left-heavy graph still opens a left-leaning block.
 *
 * The FIRST placement is always the anchor itself at (0,0). A `delta` of zero — the anchor node itself
 * re-opening — takes (0,0) back when free; every other node is scored, so a freed centre is filled only
 * when it is also the most uniform choice.
 *
 * Placed morphs are NEVER moved: placement decides where a morph goes when it OPENS. Re-ranking every
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

  // The anchor node re-opening (zero delta) belongs at the centre when it is free — the block was built
  // around (0,0). Otherwise it falls through to the uniform scoring like any node.
  if (len === 0 && !taken.has(key({ col: 0, row: 0 }))) {
    return [...placements, { nodeId, col: 0, row: 0 }];
  }
  const ux = len === 0 ? 0 : delta.dx / len;
  const uy = len === 0 ? 0 : delta.dy / len;
  const occupied = placements.map((p) => ({ col: p.col, row: p.row }));

  // Score every free cell out to `maxRing`. Compactness is lexicographically PRIMARY: a smaller longer
  // side wins, then fewer holes, so the block collapses toward a square with no gaps. Direction only
  // separates cells that are equally uniform, and a deterministic (col,row) order settles the rest so
  // the same graph always lays out identically.
  // From ring 0: the origin is a candidate too, so a centre freed by the anchor's morph closing gets
  // filled when that keeps the block compact (it is normally `taken`, hence skipped). The zero-delta
  // anchor re-open above already claimed a free (0,0), so this only reconsiders it for other nodes.
  let best: { cell: GridCell; maxDim: number; holes: number; align: number } | null = null;
  for (let r = 0; r <= maxRing; r++) {
    for (const c of ringCells(r)) {
      if (taken.has(key(c))) continue;
      const { maxDim, holes } = uniformity([...occupied, c]);
      const align = alignment(c, ux, uy);
      const better =
        !best
        || maxDim < best.maxDim
        || (maxDim === best.maxDim && holes < best.holes)
        || (maxDim === best.maxDim && holes === best.holes && align > best.align + 1e-9)
        || (maxDim === best.maxDim && holes === best.holes && Math.abs(align - best.align) <= 1e-9
            && (c.col < best.cell.col || (c.col === best.cell.col && c.row < best.cell.row)));
      if (better) best = { cell: c, maxDim, holes, align };
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
