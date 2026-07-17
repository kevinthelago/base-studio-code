// The `scalar` structure renderer (#3268, epic #3171) — a `StructureRenderer<"scalar">` that draws a
// `ScalarFrame` (the named state variables: counters, accumulators, the current pointer) as a compact ROW
// of name:value chips. It stamps each chip's `data-op` state for the kit animations from the frame's
// per-VARIABLE `ops` record (keyed by name, unlike the array/stack positional op arrays): `set` when a
// variable is replaced, `add` when a counter ticks, `compare` on a threshold read. The renderer never
// writes animation CSS (see scalarViewMotion.ts); it only stamps the state.
import { useEffect } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import type { OpStateAttrs } from "../../lib/binding";
import type { ScalarFrame } from "../../lib/trace";
import type { StructureRenderer } from "../registry";
import { SCALAR_VIZ_ANIM_CLASSES, ensureScalarViewMotion } from "./scalarViewMotion";
import "./scalarView.css";

/** The `data-op` for variable `name` — read straight from the frame's per-variable `ops` record (a scalar
 *  op names no position; it's keyed by the variable it touched). Empty when the variable is untouched this
 *  frame. */
function scalarVarState(frame: ScalarFrame, name: string): OpStateAttrs {
  const op = frame.ops?.[name];
  return op ? { "data-op": op.op } : {};
}

/**
 * Render a `ScalarFrame` as a row of name:value chips (variables sorted by name for a stable order), each
 * stamping the `data-op` the set/add/compare animations bind to. Pure over the frame — the player advances
 * frames; the kit animations fire off the stamped states. This is the co-star panel a scene pairs with a
 * main structure (Dijkstra → graph + distance + this).
 */
export const ScalarView: StructureRenderer<"scalar"> = ({ frame }: { frame: ScalarFrame }) => {
  useEffect(() => {
    ensureScalarViewMotion();
  }, []);

  const names = Object.keys(frame.values).sort();

  return (
    <Box className={`scalar-view ${SCALAR_VIZ_ANIM_CLASSES}`} role="group" aria-label="scalar state">
      {names.length === 0 ? (
        <Box className="scalar-empty" aria-label="empty">
          (no variables)
        </Box>
      ) : (
        names.map((name) => (
          <Box
            key={name}
            className="scalar-chip"
            role="group"
            aria-label={name}
            {...scalarVarState(frame, name)}
            title={`${name} = ${frame.values[name]}`}
          >
            <Text as="span" className="scalar-name mono">
              {name}
            </Text>
            <Text as="span" className="scalar-val mono">
              {frame.values[name]}
            </Text>
          </Box>
        ))
      )}
    </Box>
  );
};
