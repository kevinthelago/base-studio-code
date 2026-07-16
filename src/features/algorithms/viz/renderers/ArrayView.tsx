// The `array` structure renderer (#3178, epic #3171) — a `StructureRenderer<"array">` that draws an
// `ArrayFrame` as a row of value-cells (a bar whose height ∝ value, plus the value), stamps each cell's
// `data-op` / `data-mark` via the shared `opStateAttrs` binding, and draws the frame's `cursors` as
// labeled pills above their indices.
//
// The renderer NEVER writes animation CSS — it only stamps the state (see `lib/binding.ts`). The
// designed `compare` / `swap` / `set` / `sorted` animations bind to those `[data-op=…]` / `[data-mark=…]`
// selectors in `arrayView.css` (this proof's stand-in for the designer-authored KitAnimations, #2942 —
// see docs/algorithm-visualization.md). Change an animation once → every sort visualization updates.

import { Box } from "@/shared/ui/layout/Box";
import { opStateAttrs } from "../../lib/binding";
import type { ArrayFrame } from "../../lib/trace";
import type { StructureRenderer } from "../registry";
import "./arrayView.css";

/** The numeric magnitude of a cell (strings — non-numeric labels — contribute no bar). */
function magnitude(v: number | string): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Group a frame's `cursors` (`{ i: 3, j: 5 }`) by the index they point at, so an index that several
 *  cursors share (e.g. `i === j`) draws all their pills stacked. Names sorted for a stable render. */
function cursorsByIndex(cursors: ArrayFrame["cursors"]): Map<number, string[]> {
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
 * Render an `ArrayFrame` as a row of cells. Each cell carries the `data-op` / `data-mark` state the
 * animations bind to (via {@link opStateAttrs}); its bar height is the value as a fraction of the frame's
 * max magnitude; cursor pills sit above the indices they point at. Pure over the frame — no timing here
 * (the player advances frames; the kit animations fire off the stamped states).
 */
export const ArrayView: StructureRenderer<"array"> = ({ frame }: { frame: ArrayFrame }) => {
  const { data, ops, cursors } = frame;
  const max = Math.max(1, ...data.map(magnitude));
  const cursorPills = cursorsByIndex(cursors);

  return (
    <Box className="array-view" role="list" aria-label="array">
      {data.map((v, i) => {
        const names = cursorPills.get(i) ?? [];
        // A visible floor so a value of 0 / a string still shows a nub instead of nothing.
        const heightPct = Math.max(8, Math.round((magnitude(v) / max) * 100));
        return (
          <Box key={i} className="array-col" role="listitem">
            <Box className="array-cursors" aria-hidden={names.length === 0}>
              {names.map((name) => (
                <Box as="span" key={name} className="array-cursor-pill">
                  {name}
                </Box>
              ))}
            </Box>
            <Box className="array-cell" {...opStateAttrs(ops, i)} title={String(v)}>
              <Box as="span" className="array-bar" style={{ height: `${heightPct}%` }} aria-hidden />
              <Box as="span" className="array-val mono">
                {v}
              </Box>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
};
