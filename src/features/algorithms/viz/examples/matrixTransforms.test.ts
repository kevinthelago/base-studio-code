// Matrix transform trace-programs (#3221) — each transforms correctly (so the animation is faithful) and
// the transforms produce different results + traces (not one shared animation).
import { describe, it, expect } from "vitest";
import { TracedMatrix } from "../../lib/tracer";
import { transpose, rotate90, reflect, MATRIX_PROGRAMS, parseMatrixInput, matrixToText } from "./matrixTransforms";
import type { MatrixFrame } from "../../lib/trace";

const D = [
  [1, 2, 3, 4],
  [5, 6, 7, 8],
  [9, 10, 11, 12],
  [13, 14, 15, 16],
];

function result(fn: (m: TracedMatrix) => void, input: number[][]): number[][] {
  const m = new TracedMatrix(input);
  fn(m);
  return m.values();
}
const framesOf = (fn: (m: TracedMatrix) => void, input: number[][]) => {
  const m = new TracedMatrix(input);
  fn(m);
  return m.trace();
};

describe("matrix transforms (#3221)", () => {
  it("transpose reflects across the main diagonal", () => {
    expect(result(transpose, D)).toEqual([
      [1, 5, 9, 13],
      [2, 6, 10, 14],
      [3, 7, 11, 15],
      [4, 8, 12, 16],
    ]);
  });

  it("rotate90 rotates 90° clockwise", () => {
    expect(result(rotate90, D)).toEqual([
      [13, 9, 5, 1],
      [14, 10, 6, 2],
      [15, 11, 7, 3],
      [16, 12, 8, 4],
    ]);
  });

  it("reflect mirrors left↔right", () => {
    expect(result(reflect, D)).toEqual([
      [4, 3, 2, 1],
      [8, 7, 6, 5],
      [12, 11, 10, 9],
      [16, 15, 14, 13],
    ]);
  });

  it("the three transforms are genuinely different (distinct results)", () => {
    const t = JSON.stringify(result(transpose, D));
    const r = JSON.stringify(result(rotate90, D));
    const f = JSON.stringify(result(reflect, D));
    expect(new Set([t, r, f]).size).toBe(3);
  });

  it("each records a write-op trace ending on the transformed grid", () => {
    for (const [name, prog] of Object.entries(MATRIX_PROGRAMS)) {
      const frames = framesOf(prog.run, D) as MatrixFrame[];
      expect(frames.length).toBeGreaterThan(1);
      // every op is a matrix write (transforms move cells), and the final frame is the result.
      const ops = frames.flatMap((fr) => fr.ops ?? []);
      expect(ops.length).toBeGreaterThan(0);
      expect(ops.every((o) => o.op === "write")).toBe(true);
      expect(result(prog.run, D)).toEqual(frames[frames.length - 1].data);
      expect(name).toBeTruthy();
    }
  });

  it("works on a 3×3 too (odd size)", () => {
    const three = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
    expect(result(rotate90, three)).toEqual([[7, 4, 1], [8, 5, 2], [9, 6, 3]]);
    expect(result(transpose, three)).toEqual([[1, 4, 7], [2, 5, 8], [3, 6, 9]]);
  });
});

describe("parseMatrixInput / matrixToText (#3221)", () => {
  it("parses a square grid — rows by ';' or newline, cells by comma/space", () => {
    expect(parseMatrixInput("1,2 ; 3,4")).toEqual([[1, 2], [3, 4]]);
    expect(parseMatrixInput("1 2\n3 4")).toEqual([[1, 2], [3, 4]]);
    expect(matrixToText([[1, 2], [3, 4]])).toBe("1, 2 ; 3, 4");
  });

  it("rejects empty, non-numeric, ragged, or non-square input", () => {
    expect(() => parseMatrixInput("  ")).toThrow(/Enter a grid/i);
    expect(() => parseMatrixInput("1,x ; 3,4")).toThrow(/"x" is not a number/);
    expect(() => parseMatrixInput("1,2,3 ; 4,5")).toThrow(/SQUARE/i); // ragged
    expect(() => parseMatrixInput("1,2 ; 3,4 ; 5,6")).toThrow(/SQUARE/i); // 3×2 non-square
  });
});
