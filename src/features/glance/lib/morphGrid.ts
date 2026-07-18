// The Glance morph GRID (#3361) — pure, React-free geometry + slot bookkeeping for the in-graph
// terminal morphs, so the layout is unit-testable without rendering a terminal.
//
// THE MODEL: morphs stay IN the graph (a node grows into its live session in place — that is the whole
// point of the morph, #2534). What changes is that a morph no longer free-floats at its own node's
// coords, where two open morphs would sit on top of each other. Instead each grows into a discrete GRID
// SLOT, so non-overlap is guaranteed by construction rather than by a soft push-apart relaxation.
//
// THE FIRST OPENED NODE DEFINES THE GRID. Its morph lands exactly where a single morph lands today —
// centred on its own node — and that box becomes slot 0. Every later morph aligns to the grid built off
// it. The origin is derived from the ANCHOR NODE (an id) rather than frozen as raw coords, so the grid
// tracks the graph if the layout recomputes (the live-status overlays rebuild the model every poll).
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
/** Columns before wrapping to the next row. Three keeps the block roughly screen-shaped rather than a
 *  long horizontal strip the user has to pan along. */
export const GRID_COLS = 3;

/** The shared cell size — mutated as one by any morph's resize handles. */
export interface CellSize { w: number; h: number }

export const DEFAULT_CELL: CellSize = { w: CELL_W, h: CELL_H };

/** As much of a node as the grid geometry needs. */
export interface GridAnchorNode { x: number; y: number }

/**
 * Slot 0's top-left, in world coords: the cell CENTRED on the anchor node — byte-identical to the
 * pre-grid morph's own box (`node.x + NW/2 - CARD_W/2`). This is what makes opening the first node look
 * exactly as it always has; the grid only becomes visible from the second morph on.
 */
export function gridOrigin(anchor: GridAnchorNode, cell: CellSize = DEFAULT_CELL): { x: number; y: number } {
  return { x: anchor.x + NW / 2 - cell.w / 2, y: anchor.y + NH / 2 - cell.h / 2 };
}

/** The world box of slot `index`, laid out row-major from the origin (`GRID_COLS` per row). */
export function slotRect(anchor: GridAnchorNode, index: number, cell: CellSize = DEFAULT_CELL): MorphRect {
  const o = gridOrigin(anchor, cell);
  const col = index % GRID_COLS;
  const row = Math.floor(index / GRID_COLS);
  return {
    left: o.x + col * (cell.w + GRID_GAP),
    top:  o.y + row * (cell.h + GRID_GAP),
    w: cell.w,
    h: cell.h,
  };
}

/**
 * The bounding box of every open morph — the single region the graph parts around. Null when none are
 * open (so the neighbours snap back).
 *
 * Unions the boxes the morphs REPORT rather than deriving them from slot indices: a morph releases its
 * box the instant it starts collapsing, several hundred ms before it unmounts, so the graph parts back
 * in step with the shrink instead of lagging a full exit animation behind it.
 */
export function unionRects(rects: readonly MorphRect[]): MorphRect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.left + r.w));
  const bottom = Math.max(...rects.map((r) => r.top + r.h));
  return { left, top, w: right - left, h: bottom - top };
}

/**
 * Place `nodeId` in the LOWEST free slot, reusing a hole left by a closed morph before appending.
 *
 * Slots are STABLE while open: opening or closing a sibling never moves an existing morph. A terminal
 * the user is reading (or typing into) must not jump, which rules out compacting the array on close.
 * Returns the array unchanged if `nodeId` is already placed, so opening an open node is a no-op rather
 * than a duplicate.
 */
export function placeInSlot(slots: readonly (string | null)[], nodeId: string): (string | null)[] {
  if (slots.includes(nodeId)) return slots.slice();
  const free = slots.indexOf(null);
  const next = slots.slice();
  if (free >= 0) next[free] = nodeId;
  else next.push(nodeId);
  return next;
}

/** Free `nodeId`'s slot, then drop trailing holes so the occupied region stays tight. Siblings keep
 *  their slots — only the trailing empties collapse. */
export function releaseSlot(slots: readonly (string | null)[], nodeId: string): (string | null)[] {
  const next = slots.map((s) => (s === nodeId ? null : s));
  while (next.length > 0 && next[next.length - 1] === null) next.pop();
  return next;
}

/** The node ids currently occupying a slot, in slot order (holes skipped). */
export function occupants(slots: readonly (string | null)[]): string[] {
  return slots.filter((s): s is string => !!s);
}

/** Clamp a proposed shared cell size to the resize bounds. */
export function clampCell(w: number, h: number): CellSize {
  return {
    w: Math.min(Math.max(w, CELL_MIN_W), CELL_MAX_W),
    h: Math.min(Math.max(h, CELL_MIN_H), CELL_MAX_H),
  };
}
