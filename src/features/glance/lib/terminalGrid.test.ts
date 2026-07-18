import { describe, it, expect } from "vitest";
import { gridShape, orderByPosition, ROW_BAND, type GridNodePos } from "./terminalGrid";

describe("gridShape (#3361)", () => {
  it("has no shape with nothing open", () => {
    expect(gridShape(0)).toEqual({ cols: 0, rows: 0 });
    expect(gridShape(-1)).toEqual({ cols: 0, rows: 0 });
  });

  it("grows one cell → side-by-side → 2×2 → 3×2", () => {
    expect(gridShape(1)).toEqual({ cols: 1, rows: 1 });
    expect(gridShape(2)).toEqual({ cols: 2, rows: 1 });
    expect(gridShape(3)).toEqual({ cols: 2, rows: 2 });
    expect(gridShape(4)).toEqual({ cols: 2, rows: 2 });
    expect(gridShape(5)).toEqual({ cols: 3, rows: 2 });
    expect(gridShape(6)).toEqual({ cols: 3, rows: 2 });
  });

  it("caps at 3 columns and grows ROWS past six — a 4th column would wrap terminal output", () => {
    for (const n of [7, 9, 12, 40]) expect(gridShape(n).cols).toBe(3);
    expect(gridShape(7)).toEqual({ cols: 3, rows: 3 });
    expect(gridShape(9)).toEqual({ cols: 3, rows: 3 });
    expect(gridShape(10)).toEqual({ cols: 3, rows: 4 });
  });

  it("always has room for every open session", () => {
    for (let n = 1; n <= 30; n++) {
      const { cols, rows } = gridShape(n);
      expect(cols * rows).toBeGreaterThanOrEqual(n);
    }
  });
});

describe("orderByPosition (#3361 — the grid reads as a projection of the graph)", () => {
  // Two graph rows of two nodes each. Ids are deliberately NOT in position order, so a passing test
  // can't be explained by insertion or alphabetical order.
  const POS: GridNodePos[] = [
    { id: "zeta",  x: 900, y: 40 },   // top row, right
    { id: "alpha", x: 100, y: 40 },   // top row, left
    { id: "mid",   x: 500, y: 400 },  // lower row, left
    { id: "omega", x: 800, y: 400 },  // lower row, right
  ];

  it("orders by graph row first, then left-to-right within the row", () => {
    expect(orderByPosition(["omega", "zeta", "mid", "alpha"], POS))
      .toEqual(["alpha", "zeta", "mid", "omega"]);
  });

  it("treats nodes within a row BAND as the same row, so a slight y jitter doesn't reorder them", () => {
    const jittered: GridNodePos[] = [
      { id: "right", x: 900, y: 10 },
      { id: "left",  x: 100, y: 10 + ROW_BAND - 1 },  // same band despite the y gap
    ];
    expect(orderByPosition(["right", "left"], jittered)).toEqual(["left", "right"]);
  });

  it("separates nodes once they are further apart than a band — the lower one sorts after, however far LEFT it sits", () => {
    const stacked: GridNodePos[] = [
      { id: "lower", x: 0,   y: ROW_BAND + 1 },   // its own row: below, and further LEFT
      { id: "upper", x: 900, y: 0 },
    ];
    expect(orderByPosition(["lower", "upper"], stacked)).toEqual(["upper", "lower"]);
  });

  // Regression (#3361): row membership is RELATIVE, so a pair a few px apart is one row wherever it
  // sits. An absolute `floor(y / ROW_BAND)` bucket split exactly this pair — the jitter case above
  // passes under both schemes only because it happens not to straddle a bucket edge.
  it("keeps a near-identical pair in one row even when it straddles a multiple of ROW_BAND", () => {
    const straddling: GridNodePos[] = [
      { id: "right", x: 900, y: ROW_BAND - 1 },
      { id: "left",  x: 100, y: ROW_BAND + 1 },
    ];
    expect(orderByPosition(["right", "left"], straddling)).toEqual(["left", "right"]);
  });

  it("is a TOTAL, stable order — identical positions fall back to id", () => {
    const same: GridNodePos[] = [{ id: "b", x: 10, y: 10 }, { id: "a", x: 10, y: 10 }];
    // A flapping key order would remount the cells, tearing down each terminal's host claim.
    expect(orderByPosition(["b", "a"], same)).toEqual(["a", "b"]);
    expect(orderByPosition(["a", "b"], same)).toEqual(["a", "b"]);
  });

  it("sorts ids with no known position LAST rather than throwing (a node that left the model)", () => {
    expect(orderByPosition(["ghost", "alpha"], POS)).toEqual(["alpha", "ghost"]);
  });

  it("does not mutate its input", () => {
    const ids = ["omega", "alpha"];
    orderByPosition(ids, POS);
    expect(ids).toEqual(["omega", "alpha"]);
  });
});
