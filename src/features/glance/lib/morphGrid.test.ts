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

// ── The #3367 behaviour: a node's morph opens on the side its NODE sits ─────────────────────────────
describe("placeByDirection (#3367 — direction relative to the anchor node)", () => {
  it("the first opened node anchors the grid at (0,0)", () => {
    expect(rooted()).toEqual([{ nodeId: "root", col: 0, row: 0 }]);
  });

  it("a node to the LEFT of the anchor opens to the LEFT — the reported bug", () => {
    const ps = place(rooted(), "west", -900, 0);
    expect(cellOf(ps, "west")).toEqual({ col: -1, row: 0 });
  });

  it("maps each of the four cardinal directions to its own side", () => {
    expect(cellOf(place(rooted(), "n", 0, -900), "n")).toEqual({ col: 0, row: -1 });
    expect(cellOf(place(rooted(), "s", 0, 900), "s")).toEqual({ col: 0, row: 1 });
    expect(cellOf(place(rooted(), "e", 900, 0), "e")).toEqual({ col: 1, row: 0 });
    expect(cellOf(place(rooted(), "w", -900, 0), "w")).toEqual({ col: -1, row: 0 });
  });

  it("maps the four diagonals to diagonal cells", () => {
    expect(cellOf(place(rooted(), "ne", 700, -700), "ne")).toEqual({ col: 1, row: -1 });
    expect(cellOf(place(rooted(), "nw", -700, -700), "nw")).toEqual({ col: -1, row: -1 });
    expect(cellOf(place(rooted(), "se", 700, 700), "se")).toEqual({ col: 1, row: 1 });
    expect(cellOf(place(rooted(), "sw", -700, 700), "sw")).toEqual({ col: -1, row: 1 });
  });

  it("uses DIRECTION, not distance — a node just barely left still opens left", () => {
    // Node offsets are small next to a 760-wide cell; placement must not quantise the raw delta.
    expect(cellOf(place(rooted(), "near", -12, 0), "near")).toEqual({ col: -1, row: 0 });
  });

  it("keeps two nodes on the SAME side on that side — the second takes a neighbouring cell, never the opposite", () => {
    let ps = rooted();
    ps = place(ps, "west1", -900, -20);
    ps = place(ps, "west2", -900, 20);
    expect(cellOf(ps, "west1").col).toBe(-1);
    expect(cellOf(ps, "west2").col).toBe(-1);            // still on the LEFT
    expect(cellOf(ps, "west2")).not.toEqual(cellOf(ps, "west1"));
  });

  it("spills FURTHER LEFT rather than into a near cell on the wrong side, once the left ring-1 cells fill", () => {
    let ps = rooted();
    ps = place(ps, "w1", -900, 0);      // (-1, 0)
    ps = place(ps, "w2", -900, -20);    // (-1,-1)
    ps = place(ps, "w3", -900, 20);     // (-1, 1)
    ps = place(ps, "w4", -900, 5);      // left ring-1 is full
    // The near-but-wrong option is (0,1) — one cell BELOW the anchor, on no particular side. A
    // first-free-ring search took it; the distance-penalised global score correctly prefers (-2,0),
    // which is further away but still unambiguously LEFT.
    expect(cellOf(ps, "w4")).toEqual({ col: -2, row: 0 });
    for (const id of ["w1", "w2", "w3", "w4"]) expect(cellOf(ps, id).col).toBeLessThan(0);
  });

  it("NEVER lands a node on the opposite side of the anchor from where its node sits", () => {
    // The invariant behind the whole issue: whatever else placement does, the sign of the dominant axis
    // must never flip. Ten left-hand nodes stay left; ten upper nodes stay up.
    let west = rooted();
    for (let i = 0; i < 10; i++) west = place(west, `w${i}`, -900, (i - 5) * 30);
    for (const p of west) if (p.nodeId !== "root") expect(p.col).toBeLessThan(0);

    let north = rooted();
    for (let i = 0; i < 10; i++) north = place(north, `n${i}`, (i - 5) * 30, -900);
    for (const p of north) if (p.nodeId !== "root") expect(p.row).toBeLessThan(0);
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

  it("does not steal the freed CENTRE for a node that clearly belongs to one side", () => {
    let ps = rooted();
    ps = place(ps, "west", -900, 0);
    ps = releaseCell(ps, "root");                        // the anchor's own morph closed; (0,0) is free
    ps = place(ps, "east", 900, 0);
    expect(cellOf(ps, "east")).toEqual({ col: 1, row: 0 });
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
