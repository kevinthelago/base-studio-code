// The `matrix` renderer (#3221) — draws a MatrixFrame as a grid and stamps each cell's data-op via the
// shared cellOpStateAttrs binding (so the designed read/write/region animations fire).
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MatrixView } from "./MatrixView";
import { cellOpStateAttrs } from "../../lib/binding";
import type { MatrixFrame } from "../../lib/trace";

const frame: MatrixFrame = {
  structure: "matrix",
  data: [
    [1, 2],
    [3, 4],
  ],
  ops: [
    { op: "write", at: [0, 1] },
    { op: "write", at: [1, 0] },
  ],
};

describe("MatrixView (#3221)", () => {
  it("renders every cell and stamps data-op on the written cells", () => {
    const { container } = render(<MatrixView frame={frame} />);
    const cells = container.querySelectorAll(".matrix-cell");
    expect(cells.length).toBe(4);
    expect([...cells].map((c) => c.textContent)).toEqual(["1", "2", "3", "4"]);
    // the two written cells carry data-op="write"; the others carry none.
    expect(container.querySelectorAll('.matrix-cell[data-op="write"]').length).toBe(2);
  });
});

describe("cellOpStateAttrs (#3221)", () => {
  it("stamps read/write on the targeted cell and region over a block", () => {
    const ops = [
      { op: "write", at: [0, 1] as [number, number] },
      { op: "region", rows: [1, 1] as [number, number], cols: [0, 1] as [number, number], as: "row" },
    ];
    expect(cellOpStateAttrs(ops, 0, 1)).toEqual({ "data-op": "write" });
    expect(cellOpStateAttrs(ops, 0, 0)).toEqual({}); // untouched
    expect(cellOpStateAttrs(ops, 1, 0)).toEqual({ "data-mark": "row" }); // inside the labelled region
    expect(cellOpStateAttrs(ops, 1, 1)).toEqual({ "data-mark": "row" });
  });

  it("an unlabelled region stamps data-op=region", () => {
    const ops = [{ op: "region", rows: [0, 0] as [number, number], cols: [0, 0] as [number, number] }];
    expect(cellOpStateAttrs(ops, 0, 0)).toEqual({ "data-op": "region" });
  });
});
