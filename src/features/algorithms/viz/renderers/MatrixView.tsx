// The `matrix` structure renderer (#3221, epic #3220) — a `StructureRenderer<"matrix">` that draws a
// `MatrixFrame` as a CSS-grid of value cells and stamps each cell's `data-op` / `data-mark` via the shared
// `cellOpStateAttrs` binding. Like ArrayView, it NEVER writes animation CSS — it only stamps the state; the
// read / write / region animations are designer-authored KitAnimation data compiled by the kit-motion
// engine (`matrixViewMotion.ts`). Its root carries the applying classes; cells only stamp the state.
import { useEffect } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { cellOpStateAttrs } from "../../lib/binding";
import type { MatrixFrame } from "../../lib/trace";
import type { StructureRenderer } from "../registry";
import { MATRIX_VIZ_ANIM_CLASSES, ensureMatrixViewMotion } from "./matrixViewMotion";
import "./matrixView.css";

/**
 * Render a `MatrixFrame` as a grid of cells. Each cell carries the `data-op` / `data-mark` state the matrix
 * animations bind to (via {@link cellOpStateAttrs}); cursor support + heat maps are follow-ups. Pure over
 * the frame — no timing here (the player advances frames; the kit animations fire off the stamped states).
 */
export const MatrixView: StructureRenderer<"matrix"> = ({ frame }: { frame: MatrixFrame }) => {
  // Ensure the kit's compiled motion CSS is present — the state-triggered animations bound to the
  // data-states this renderer stamps. Idempotent; no per-render cost.
  useEffect(() => {
    ensureMatrixViewMotion();
  }, []);

  const { data, ops } = frame;
  const cols = data[0]?.length ?? 0;

  return (
    // The root carries the applying classes so the `[data-op=…]` state rules scope to its cells.
    <Box
      className={`matrix-view ${MATRIX_VIZ_ANIM_CLASSES}`}
      role="grid"
      aria-label="matrix"
      style={{ gridTemplateColumns: `repeat(${cols}, var(--matrix-cell, 42px))` }}
    >
      {data.map((row, r) =>
        row.map((v, c) => (
          <Box
            key={`${r}-${c}`}
            className="matrix-cell mono"
            role="gridcell"
            {...cellOpStateAttrs(ops, r, c)}
            title={String(v)}
          >
            {v}
          </Box>
        )),
      )}
    </Box>
  );
};
