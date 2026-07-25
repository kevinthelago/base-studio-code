import { describe, it, expect } from "vitest";
import {
  gridOrigin, cellRect, ringCells, unionRects, placeByDirection, releaseCell, occupants, clampCell,
  CELL_W, CELL_H, GRID_GAP, DEFAULT_CELL,
  CELL_MIN_W, CELL_MIN_H, CELL_MAX_W, CELL_MAX_H,
  type MorphPlacement, type GridCell,
} from "./morphGrid";
import { NW, NH } from "./glanceGraph";
import type { MorphRect } from "./glancePush";

const ANCHOR = { x: 100, y: 100 };
/** Do two world boxes overlap at all? The property the whole grid exists to guarantee. */
const overlaps = (a: MorphRect, b: MorphRect) =>
  a.left < b.left + b.w && b.left < a.left + a.w && a.top < b.top + b.h && b.top < a.top + a.h;

/** Place `id` at world offset (dx,dy) from the anchor node — the shape the workspace passes in. */
const place = (ps: MorphPlacement[], id: string, dx: number, dy: number) =>
  placeByDirection(ps, id, { dx, dy });
/** The cell `id` ended up in. */
const cellOf = (ps: MorphPlacement[], id: string): GridCell => {
  const p = ps.find((x) => x.nodeId === id)!;
  return { col: p.col, row: p.row };
};
/** An anchor placement to build on — "root" occupies (0,0). */
const rooted = () => place([], "root", 0, 0);

describe("gridOrigin (#3361 — the first opened node defines the grid)", () => {
  it("centres cell (0,0) on the anchor node — byte-identical to the pre-grid single morph's own box", () => {
    // The morph used to compute `node.x + NW/2 - CARD_W/2`. Opening ONE node must look unchanged.
    expect(gridOrigin(ANCHOR)).toEqual({
      x: ANCHOR.x + NW / 2 - CELL_W / 2,
      y: ANCHOR.y + NH / 2 - CELL_H / 2,
    });
  });

  it("re-centres when the shared cell is resized, so the grid stays anchored on the node", () => {
    expect(gridOrigin(ANCHOR, { w: 400, h: 300 })).toEqual({
      x: ANCHOR.x + NW / 2 - 200,
      y: ANCHOR.y + NH / 2 - 150,
    });
  });
});

describe("cellRect (#3367 — a SIGNED lattice)", () => {
  it("places cell (0,0) at the origin", () => {
    const o = gridOrigin(ANCHOR);
    expect(cellRect(ANCHOR, { col: 0, row: 0 })).toEqual({ left: o.x, top: o.y, w: CELL_W, h: CELL_H });
  });

  it("puts NEGATIVE cells left of / above the anchor — the whole point of #3367", () => {
    const o = gridOrigin(ANCHOR);
    expect(cellRect(ANCHOR, { col: -1, row: 0 }).left).toBe(o.x - (CELL_W + GRID_GAP));
    expect(cellRect(ANCHOR, { col: 0, row: -1 }).top).toBe(o.y - (CELL_H + GRID_GAP));
    expect(cellRect(ANCHOR, { col: 1, row: 0 }).left).toBe(o.x + (CELL_W + GRID_GAP));
    expect(cellRect(ANCHOR, { col: 0, row: 1 }).top).toBe(o.y + (CELL_H + GRID_GAP));
  });

  it("NEVER overlaps any other cell — the guarantee the grid exists to provide", () => {
    const rects = [{ col: 0, row: 0 }, ...ringCells(1), ...ringCells(2)].map((c) => cellRect(ANCHOR, c));
    for (let a = 0; a < rects.length; a++) {
      for (let b = a + 1; b < rects.length; b++) {
        expect(overlaps(rects[a], rects[b])).toBe(false);
      }
    }
  });

  it("still never overlaps at the MAXIMUM cell size", () => {
    const cell = { w: CELL_MAX_W, h: CELL_MAX_H };
    const rects = [{ col: 0, row: 0 }, ...ringCells(1)].map((c) => cellRect(ANCHOR, c, cell));
    for (let a = 0; a < rects.length; a++) {
      for (let b = a + 1; b < rects.length; b++) {
        expect(overlaps(rects[a], rects[b])).toBe(false);
      }
    }
  });

  it("tracks the anchor node — the grid moves with the graph rather than freezing at open time", () => {
    const moved = { x: ANCHOR.x + 500, y: ANCHOR.y - 250 };
    const at = { col: -2, row: 1 };
    expect(cellRect(moved, at).left - cellRect(ANCHOR, at).left).toBe(500);
    expect(cellRect(moved, at).top - cellRect(ANCHOR, at).top).toBe(-250);
  });
});

describe("ringCells (#3367)", () => {
  it("ring 0 is the origin; ring 1 is the eight neighbours; ring r has 8r cells", () => {
    expect(ringCells(0)).toEqual([{ col: 0, row: 0 }]);
    expect(ringCells(1)).toHaveLength(8);
    expect(ringCells(2)).toHaveLength(16);
    expect(ringCells(3)).toHaveLength(24);
  });

  it("every cell in ring r is at Chebyshev distance exactly r", () => {
    for (const c of ringCells(3)) expect(Math.max(Math.abs(c.col), Math.abs(c.row))).toBe(3);
  });
});

// ── #3525: placement is UNIFORMITY-first (a tidy tile block), DIRECTION second (the block leans toward
//    the side its nodes sit). Replaces the direction-first #3367 contract, which left sparse strips. ──
/** The bounding box of a set of cells + how many of its cells are empty. */
const blockShape = (ps: MorphPlacement[]) => {
  const cols = ps.map((p) => p.col), rows = ps.map((p) => p.row);
  const w = Math.max(...cols) - Math.min(...cols) + 1;
  const h = Math.max(...rows) - Math.min(...rows) + 1;
  return { w, h, maxDim: Math.max(w, h), holes: w * h - ps.length };
};
/** The mean cell of the block — used to assert which SIDE of the anchor the block leans to. */
const centroid = (ps: MorphPlacement[]) => ({
  col: ps.reduce((a, p) => a + p.col, 0) / ps.length,
  row: ps.reduce((a, p) => a + p.row, 0) / ps.length,
});

describe("placeByDirection (#3525 — uniformity first, direction second)", () => {
  it("the first opened node anchors the grid at (0,0)", () => {
    expect(rooted()).toEqual([{ nodeId: "root", col: 0, row: 0 }]);
  });

  it("a SECOND node opens adjacent to the anchor on its side — a tight 2×1, never a diagonal", () => {
    // Two nodes: the most uniform block is a 2×1 with no holes; direction picks WHICH side.
    expect(cellOf(place(rooted(), "n", 0, -900), "n")).toEqual({ col: 0, row: -1 });
    expect(cellOf(place(rooted(), "s", 0, 900), "s")).toEqual({ col: 0, row: 1 });
    expect(cellOf(place(rooted(), "e", 900, 0), "e")).toEqual({ col: 1, row: 0 });
    expect(cellOf(place(rooted(), "w", -900, 0), "w")).toEqual({ col: -1, row: 0 });
  });

  it("a DIAGONALLY-placed node still opens to an ADJACENT cell — a 2×1 beats a hole-y 2×2 (#3525)", () => {
    // Under direction-first (#3367) a NE node took the diagonal (1,-1), leaving a 2×2 with two gaps.
    // Uniformity-first prefers a gap-free 2×1: the block is adjacent, and stays on the node's side.
    for (const [dx, dy] of [[700, -700], [-700, -700], [700, 700], [-700, 700]] as const) {
      const ps = place(rooted(), "d", dx, dy);
      expect(blockShape(ps)).toMatchObject({ maxDim: 2, holes: 0 }); // adjacent, no diagonal gap
    }
  });

  it("collapses N opened nodes into a tight SQUARE — 4 → an exact 2×2, 9 → an exact 3×3", () => {
    // The heart of #3525: a filled square with NO holes, not a strip or a scatter.
    let four = rooted();
    for (const [id, dx, dy] of [["e", 900, 0], ["w", -900, 0], ["s", 0, 900]] as const) four = place(four, id, dx, dy);
    expect(blockShape(four)).toEqual({ w: 2, h: 2, maxDim: 2, holes: 0 });

    let nine = rooted();
    const dirs: [string, number, number][] = [
      ["e", 900, 0], ["w", -900, 0], ["n", 0, -900], ["s", 0, 900],
      ["ne", 700, -700], ["nw", -700, -700], ["se", 700, 700], ["sw", -700, 700],
    ];
    for (const [id, dx, dy] of dirs) nine = place(nine, id, dx, dy);
    expect(blockShape(nine)).toEqual({ w: 3, h: 3, maxDim: 3, holes: 0 });
  });

  it("never leaves an interior gap while the block is still growing", () => {
    // 'checks for a pattern before filling its slot': at every step the block is as dense as possible,
    // so holes (if any) are only the unfilled tail of the last row — always fewer than a full side.
    let ps = rooted();
    for (let i = 1; i <= 12; i++) {
      ps = place(ps, `x${i}`, ((i % 3) - 1) * 900, (Math.floor(i / 3) - 2) * 900);
      const { maxDim, holes } = blockShape(ps);
      expect(holes).toBeLessThan(maxDim); // at most a partial last row/col, never an interior void
    }
  });

  it("the block LEANS toward the side its nodes sit on — direction survives as the tiebreak", () => {
    // Individual cells may sit in the anchor's column when that completes the square, but the block's
    // centre of mass is unambiguously on the nodes' side. (Direction-first kept every cell strictly
    // sided; #3525 trades that for a uniform block that still points the right way.)
    let west = rooted();
    for (let i = 0; i < 6; i++) west = place(west, `w${i}`, -900, (i - 3) * 30);
    expect(centroid(west).col).toBeLessThan(0);

    let north = rooted();
    for (let i = 0; i < 6; i++) north = place(north, `n${i}`, (i - 3) * 30, -900);
    expect(centroid(north).row).toBeLessThan(0);
  });

  it("breaks a uniformity tie by direction — two equally-compact cells go to the matching side", () => {
    // After the anchor, a west and an east node are each a valid 2×1; direction sends them opposite ways.
    const w = cellOf(place(rooted(), "w", -900, 0), "w");
    const e = cellOf(place(rooted(), "e", 900, 0), "e");
    expect(w.col).toBeLessThan(0);
    expect(e.col).toBeGreaterThan(0);
  });

  it("never places two morphs in the same cell", () => {
    let ps = rooted();
    const dirs: [string, number, number][] = [
      ["a", -900, 0], ["b", 900, 0], ["c", 0, -900], ["d", 0, 900],
      ["e", -700, -700], ["f", 700, 700], ["g", -700, 700], ["h", 700, -700],
      ["i", -900, -30], ["j", -900, 30],
    ];
    for (const [id, dx, dy] of dirs) ps = place(ps, id, dx, dy);
    const keys = ps.map((p) => `${p.col},${p.row}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("is STABLE — placing another node never moves an existing one", () => {
    let ps = rooted();
    ps = place(ps, "west", -900, 0);
    const before = cellOf(ps, "west");
    ps = place(ps, "east", 900, 0);
    ps = place(ps, "north", 0, -900);
    expect(cellOf(ps, "west")).toEqual(before);
    expect(cellOf(ps, "root")).toEqual({ col: 0, row: 0 });
  });

  it("re-placing an already-placed node is a no-op, not a second cell", () => {
    let ps = place(rooted(), "west", -900, 0);
    ps = place(ps, "west", -900, 0);
    expect(ps.filter((p) => p.nodeId === "west")).toHaveLength(1);
  });

  it("fills a freed CENTRE to keep the block compact (#3525 — uniformity beats keeping (0,0) reserved)", () => {
    // Under direction-first (#3367) the freed anchor cell was left empty so a directional node wouldn't
    // 'steal' it. Uniformity-first fills it: leaving a hole in the middle of the block is exactly the
    // sparseness this change removes. The two morphs end up a gap-free 2×1.
    let ps = rooted();
    ps = place(ps, "west", -900, 0);                     // (-1,0)
    ps = releaseCell(ps, "root");                        // the anchor's own morph closed; (0,0) is free
    ps = place(ps, "east", 900, 0);
    const open = ps.filter((p) => p.nodeId !== "root");
    expect(blockShape(open)).toMatchObject({ maxDim: 2, holes: 0 });
    expect(open.some((p) => p.col === 0 && p.row === 0)).toBe(true); // the gap got filled
  });

  it("but the ANCHOR node itself (zero delta) takes the centre back when it re-opens", () => {
    let ps = rooted();
    ps = place(ps, "west", -900, 0);
    ps = releaseCell(ps, "root");
    ps = place(ps, "root", 0, 0);
    expect(cellOf(ps, "root")).toEqual({ col: 0, row: 0 });
  });

  it("does not mutate its input", () => {
    const ps = rooted();
    place(ps, "west", -900, 0);
    expect(ps).toEqual([{ nodeId: "root", col: 0, row: 0 }]);
  });
});

describe("releaseCell / occupants (#3361)", () => {
  it("drops one placement and leaves the others exactly where they were", () => {
    let ps = rooted();
    ps = place(ps, "west", -900, 0);
    ps = place(ps, "east", 900, 0);
    const westCell = cellOf(ps, "west");
    ps = releaseCell(ps, "east");
    expect(occupants(ps)).toEqual(["root", "west"]);
    expect(cellOf(ps, "west")).toEqual(westCell);        // no reflow — a terminal being read must not jump
  });

  it("releasing an absent node changes nothing, and does not mutate", () => {
    const ps = rooted();
    expect(releaseCell(ps, "zzz")).toEqual(ps);
    expect(ps).toHaveLength(1);
  });

  it("occupants lists the node ids in placement order", () => {
    expect(occupants(place(rooted(), "west", -900, 0))).toEqual(["root", "west"]);
    expect(occupants([])).toEqual([]);
  });
});

describe("unionRects (#3361 — the graph parts around ONE region)", () => {
  it("is null with nothing open, so the neighbours snap back", () => {
    expect(unionRects([])).toBeNull();
  });

  it("returns a single rect unchanged — parting around one morph is unchanged behaviour", () => {
    const r = cellRect(ANCHOR, { col: 0, row: 0 });
    expect(unionRects([r])).toEqual(r);
  });

  it("bounds cells on BOTH sides of the anchor (a negative col extends the region left)", () => {
    const u = unionRects([cellRect(ANCHOR, { col: -1, row: 0 }), cellRect(ANCHOR, { col: 0, row: 0 })])!;
    const o = gridOrigin(ANCHOR);
    expect(u.left).toBe(o.x - (CELL_W + GRID_GAP));
    expect(u.w).toBe(CELL_W * 2 + GRID_GAP);
    expect(u.h).toBe(CELL_H);
  });

  it("spans rows above and below", () => {
    const u = unionRects([cellRect(ANCHOR, { col: 0, row: -1 }), cellRect(ANCHOR, { col: 0, row: 1 })])!;
    expect(u.h).toBe(CELL_H * 3 + GRID_GAP * 2);
  });
});

describe("clampCell (#3361 — a shared cell size, bounded)", () => {
  it("passes a sane size through", () => {
    expect(clampCell(800, 600)).toEqual({ w: 800, h: 600 });
  });

  it("clamps to the resize bounds", () => {
    expect(clampCell(10, 10)).toEqual({ w: CELL_MIN_W, h: CELL_MIN_H });
    expect(clampCell(99999, 99999)).toEqual({ w: CELL_MAX_W, h: CELL_MAX_H });
  });

  it("the default cell is within its own bounds", () => {
    expect(clampCell(DEFAULT_CELL.w, DEFAULT_CELL.h)).toEqual(DEFAULT_CELL);
  });
});
