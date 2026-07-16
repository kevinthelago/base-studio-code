// Matrix TRANSFORM trace-programs (#3221, epic #3220/#3215) — real transform algorithms written over a
// TracedMatrix, so the animation is DERIVED from the transform's own execution and looks distinct:
// transpose swaps across the diagonal, rotate cycles each ring 90°, reflect swaps columns. In-place +
// square (so the grid keeps its shape). Keyed by base name (transpose / rotate / reflect), like the sorts.
import { TracedMatrix } from "../../lib/tracer";

/** A visualizable matrix algorithm — its real logic over a {@link TracedMatrix} + the grid to seed it. */
export interface MatrixProgram {
  run: (m: TracedMatrix) => void;
  defaultInput: readonly (readonly number[])[];
}

/** A 4×4 with distinct values, so every transform is legible cell-by-cell. */
const DEFAULT: readonly (readonly number[])[] = [
  [1, 2, 3, 4],
  [5, 6, 7, 8],
  [9, 10, 11, 12],
  [13, 14, 15, 16],
];

/** Transpose a square matrix in place — swap each (i, j) with (j, i) across the main diagonal. */
export function transpose(m: TracedMatrix): void {
  const n = m.rows;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) m.swap([i, j], [j, i]);
  }
}

/** Rotate a square matrix 90° clockwise in place — a 4-way cycle per ring (all four cells move in one
 *  frame). Every source is read from the pre-cycle state (the args evaluate before the write lands). */
export function rotate90(m: TracedMatrix): void {
  const n = m.rows;
  for (let layer = 0; layer < Math.floor(n / 2); layer++) {
    const first = layer;
    const last = n - 1 - layer;
    for (let i = first; i < last; i++) {
      const offset = i - first;
      const top = m.get(first, i);
      m.writeMany([
        { r: first, c: i, v: m.get(last - offset, first) }, // left  → top
        { r: last - offset, c: first, v: m.get(last, last - offset) }, // bottom → left
        { r: last, c: last - offset, v: m.get(i, last) }, // right → bottom
        { r: i, c: last, v: top }, // top   → right
      ]);
    }
  }
}

/** Reflect a square matrix horizontally (mirror left↔right) — swap columns c and n-1-c in every row. */
export function reflect(m: TracedMatrix): void {
  const n = m.cols;
  for (let r = 0; r < m.rows; r++) {
    for (let c = 0; c < Math.floor(n / 2); c++) m.swap([r, c], [r, n - 1 - c]);
  }
}

/** The visualizable matrix transforms, keyed by base name. Grows as more matrix algorithms are authored. */
export const MATRIX_PROGRAMS: Record<string, MatrixProgram> = {
  transpose: { run: transpose, defaultInput: DEFAULT },
  rotate: { run: rotate90, defaultInput: DEFAULT },
  reflect: { run: reflect, defaultInput: DEFAULT },
};

/** Serialize a grid to the "your input" text form (rows joined by " ; ", cells by ", "). */
export function matrixToText(grid: readonly (readonly number[])[]): string {
  return grid.map((row) => row.join(", ")).join(" ; ");
}

/**
 * Parse the "your input" text into a SQUARE number matrix — rows separated by `;` or newlines, cells by
 * comma/whitespace. Throws a helpful `Error` (shown to the user) on empty, non-numeric, ragged, non-square,
 * or unwatchably-large input.
 */
export function parseMatrixInput(text: string): number[][] {
  const rowsText = text.split(/[;\n]/).map((r) => r.trim()).filter((r) => r.length > 0);
  if (rowsText.length === 0) throw new Error("Enter a grid, e.g. 1,2 ; 3,4");
  const grid = rowsText.map((r) =>
    r
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .map((t) => {
        const n = Number(t);
        if (!Number.isFinite(n)) throw new Error(`"${t}" is not a number`);
        return n;
      }),
  );
  const n = grid.length;
  if (grid.some((row) => row.length !== n)) throw new Error("Use a SQUARE grid (same number of rows and columns)");
  if (n > 8) throw new Error("Keep it 8×8 or smaller so the animation stays watchable");
  return grid;
}
