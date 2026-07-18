import { describe, it, expect } from "vitest";
import {
  gridOrigin, slotRect, unionRects, placeInSlot, releaseSlot, occupants, clampCell,
  CELL_W, CELL_H, GRID_GAP, GRID_COLS, DEFAULT_CELL,
  CELL_MIN_W, CELL_MIN_H, CELL_MAX_W, CELL_MAX_H,
} from "./morphGrid";
import { NW, NH } from "./glanceGraph";
import type { MorphRect } from "./glancePush";

const ANCHOR = { x: 100, y: 100 };
/** Do two world boxes overlap at all? The property the whole grid exists to guarantee. */
const overlaps = (a: MorphRect, b: MorphRect) =>
  a.left < b.left + b.w && b.left < a.left + a.w && a.top < b.top + b.h && b.top < a.top + a.h;

describe("gridOrigin (#3361 — the first opened node defines the grid)", () => {
  it("centres slot 0 on the anchor node — byte-identical to the pre-grid single morph's own box", () => {
    // The morph used to compute `node.x + NW/2 - CARD_W/2`. Opening ONE node must look unchanged.
    expect(gridOrigin(ANCHOR)).toEqual({
      x: ANCHOR.x + NW / 2 - CELL_W / 2,
      y: ANCHOR.y + NH / 2 - CELL_H / 2,
    });
  });

  it("re-centres when the shared cell is resized, so the grid stays anchored on the node", () => {
    const cell = { w: 400, h: 300 };
    expect(gridOrigin(ANCHOR, cell)).toEqual({
      x: ANCHOR.x + NW / 2 - 200,
      y: ANCHOR.y + NH / 2 - 150,
    });
  });
});

describe("slotRect (#3361)", () => {
  it("places slot 0 at the origin", () => {
    const o = gridOrigin(ANCHOR);
    expect(slotRect(ANCHOR, 0)).toEqual({ left: o.x, top: o.y, w: CELL_W, h: CELL_H });
  });

  it("lays slots out row-major, wrapping after GRID_COLS", () => {
    const o = gridOrigin(ANCHOR);
    expect(slotRect(ANCHOR, 1).left).toBe(o.x + (CELL_W + GRID_GAP));
    expect(slotRect(ANCHOR, 1).top).toBe(o.y);                       // same row
    expect(slotRect(ANCHOR, GRID_COLS).left).toBe(o.x);              // wrapped back to column 0
    expect(slotRect(ANCHOR, GRID_COLS).top).toBe(o.y + (CELL_H + GRID_GAP));
  });

  it("NEVER overlaps any other slot — the guarantee the grid exists to provide", () => {
    const rects = Array.from({ length: 12 }, (_, i) => slotRect(ANCHOR, i));
    for (let a = 0; a < rects.length; a++) {
      for (let b = a + 1; b < rects.length; b++) {
        expect(overlaps(rects[a], rects[b])).toBe(false);
      }
    }
  });

  it("still never overlaps at the MAXIMUM cell size", () => {
    const cell = { w: CELL_MAX_W, h: CELL_MAX_H };
    const rects = Array.from({ length: 8 }, (_, i) => slotRect(ANCHOR, i, cell));
    for (let a = 0; a < rects.length; a++) {
      for (let b = a + 1; b < rects.length; b++) {
        expect(overlaps(rects[a], rects[b])).toBe(false);
      }
    }
  });

  it("tracks the anchor node — the grid moves with the graph rather than freezing at open time", () => {
    const moved = { x: ANCHOR.x + 500, y: ANCHOR.y - 250 };
    expect(slotRect(moved, 2).left - slotRect(ANCHOR, 2).left).toBe(500);
    expect(slotRect(moved, 2).top - slotRect(ANCHOR, 2).top).toBe(-250);
  });
});

describe("placeInSlot / releaseSlot (#3361 — stable slots, reused holes)", () => {
  it("fills slots in order", () => {
    let slots: (string | null)[] = [];
    slots = placeInSlot(slots, "a");
    slots = placeInSlot(slots, "b");
    expect(slots).toEqual(["a", "b"]);
  });

  it("is idempotent — re-opening an already-open node is a no-op, not a duplicate cell", () => {
    const slots = placeInSlot(placeInSlot([], "a"), "a");
    expect(slots).toEqual(["a"]);
  });

  it("does NOT reflow siblings on close — a terminal being read must never jump", () => {
    let slots: (string | null)[] = ["a", "b", "c"];
    slots = releaseSlot(slots, "a");
    // `b` and `c` keep slots 1 and 2; only `a`'s slot empties.
    expect(slots).toEqual([null, "b", "c"]);
  });

  it("reuses the lowest free hole before appending", () => {
    let slots: (string | null)[] = [null, "b", "c"];
    slots = placeInSlot(slots, "d");
    expect(slots).toEqual(["d", "b", "c"]);
  });

  it("drops TRAILING holes so the occupied region stays tight", () => {
    expect(releaseSlot(["a", "b"], "b")).toEqual(["a"]);
    expect(releaseSlot(["a"], "a")).toEqual([]);
    // ...but an interior hole is kept, so surviving siblings hold their slots.
    expect(releaseSlot(["a", "b", "c"], "b")).toEqual(["a", null, "c"]);
  });

  it("releasing an absent node changes nothing", () => {
    expect(releaseSlot(["a", "b"], "zzz")).toEqual(["a", "b"]);
  });

  it("does not mutate its input", () => {
    const slots: (string | null)[] = ["a"];
    placeInSlot(slots, "b");
    releaseSlot(slots, "a");
    expect(slots).toEqual(["a"]);
  });

  it("occupants lists the filled slots in slot order, skipping holes", () => {
    expect(occupants(["a", null, "c"])).toEqual(["a", "c"]);
    expect(occupants([])).toEqual([]);
  });
});

describe("unionRects (#3361 — the graph parts around ONE region)", () => {
  it("is null with nothing open, so the neighbours snap back", () => {
    expect(unionRects([])).toBeNull();
  });

  it("returns a single rect unchanged — parting around one morph is unchanged behaviour", () => {
    const r = slotRect(ANCHOR, 0);
    expect(unionRects([r])).toEqual(r);
  });

  it("bounds every open morph", () => {
    const u = unionRects([slotRect(ANCHOR, 0), slotRect(ANCHOR, 1)])!;
    const o = gridOrigin(ANCHOR);
    expect(u.left).toBe(o.x);
    expect(u.top).toBe(o.y);
    expect(u.w).toBe(CELL_W * 2 + GRID_GAP);
    expect(u.h).toBe(CELL_H);
  });

  it("spans rows once the grid wraps", () => {
    const u = unionRects([slotRect(ANCHOR, 0), slotRect(ANCHOR, GRID_COLS)])!;
    expect(u.h).toBe(CELL_H * 2 + GRID_GAP);
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
