// The `stack` structure renderer (#3266, epic #3171) — a `StructureRenderer<"stack">` that draws a
// `StackFrame` (a LIFO/FIFO/deque, `mode`-selected) as a COLUMN of value-cells, top = the active end.
// It stamps each cell's `data-op` state for the kit animations: `peek` on the inspected index (via the
// shared `opStateAttrs`), and `push`/`pop` on the ACTIVE-END cell — which end depends on `mode` (a stack
// pushes+pops the top; a queue pushes the back, pops the front). The renderer never writes animation CSS
// (see stackViewMotion.ts); it only stamps the state.
import { useEffect } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { opStateAttrs, type OpStateAttrs } from "../../lib/binding";
import type { StackFrame } from "../../lib/trace";
import type { StructureRenderer } from "../registry";
import { STACK_VIZ_ANIM_CLASSES, ensureStackViewMotion } from "./stackViewMotion";
import "./stackView.css";

/** The `data-op`/`data-mark` for the cell at `index`. `peek` (indexed) resolves via the shared
 *  {@link opStateAttrs}; the position-less `push`/`pop` land on the active-end cell — top for a stack/
 *  deque, and (for a queue) the back on push / the front on pop. */
function stackCellState(frame: StackFrame, index: number): OpStateAttrs {
  const attrs = opStateAttrs(frame.ops, index); // peek (carries `at`); push/pop carry none
  const top = frame.data.length - 1;
  const popEnd = frame.mode === "queue" ? 0 : top; // a queue dequeues the FRONT
  for (const o of frame.ops ?? []) {
    if (o.op === "push" && index === top) attrs["data-op"] = "push"; // new entry always lands at the back/top
    else if (o.op === "pop" && index === popEnd) attrs["data-op"] = "pop";
  }
  return attrs;
}

/** Group `cursors` by the index they point at (a shared index may carry several pills). Names sorted. */
function cursorsByIndex(cursors: StackFrame["cursors"]): Map<number, string[]> {
  const byIndex = new Map<number, string[]>();
  for (const name of Object.keys(cursors ?? {}).sort()) {
    const at = cursors![name];
    const list = byIndex.get(at) ?? [];
    list.push(name);
    byIndex.set(at, list);
  }
  return byIndex;
}

/**
 * Render a `StackFrame` as a column of cells (top = the active end), each stamping the `data-op` state the
 * push/pop/peek animations bind to. The `mode` badge names the discipline (stack / queue / deque) so the
 * one renderer reads correctly for each. Pure over the frame — the player advances frames; the kit
 * animations fire off the stamped states.
 */
export const StackView: StructureRenderer<"stack"> = ({ frame }: { frame: StackFrame }) => {
  useEffect(() => {
    ensureStackViewMotion();
  }, []);

  const { data, cursors } = frame;
  const mode = frame.mode ?? "stack";
  const cursorPills = cursorsByIndex(cursors);
  // Render top→bottom (the active end sits at the top of the column, like a stack of plates).
  const rows = data.map((_, i) => data.length - 1 - i);

  return (
    <Box className={`stack-view ${STACK_VIZ_ANIM_CLASSES}`} role="group" aria-label={mode}>
      <Text as="div" className="stack-mode mono" aria-hidden>
        {mode === "queue" ? "queue · front↑" : mode === "deque" ? "deque" : "stack · top↑"}
      </Text>
      <Box className="stack-col" role="list">
        {data.length === 0 ? (
          <Box className="stack-empty" aria-label="empty">
            (empty)
          </Box>
        ) : (
          rows.map((i) => {
            const names = cursorPills.get(i) ?? [];
            return (
              <Box key={i} className="stack-cell" role="listitem" {...stackCellState(frame, i)} title={String(data[i])}>
                <Text as="span" className="stack-val mono">
                  {data[i]}
                </Text>
                {names.length > 0 && (
                  <Box as="span" className="stack-cursor mono" aria-hidden>
                    {names.join(" ")}
                  </Box>
                )}
              </Box>
            );
          })
        )}
      </Box>
    </Box>
  );
};
