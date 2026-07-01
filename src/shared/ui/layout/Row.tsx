// Row — a horizontal flex row with a gap (#2056). The one primitive for the ~150 hand-rolled
// `<div style={{ display: "flex", alignItems: "center", gap: N }}>` divs across the app.
//
// Cross-axis default is `center` (the dominant intent for a row of controls/labels) — pass
// `align="baseline"`/`"start"`/… for the others, or `align="stretch"` for the bare `flex + gap`
// case that set no `alignItems`. Pair with <Spacer/> to push trailing items to the end. Any extra
// div prop passes through; a `style` override wins last.

import type { ReactNode, CSSProperties, ComponentPropsWithoutRef } from "react";
import { flexStyle, pad, type Space, type Align, type Justify } from "./space";

export interface RowProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  children?: ReactNode;
  /** Gap between children — a scale rung ("sm"/"md"/…) or raw px. */
  gap?: Space;
  /** Cross-axis (vertical) alignment. Default = `center`. */
  align?: Align;
  /** Main-axis (horizontal) distribution. */
  justify?: Justify;
  /** Allow items to wrap onto multiple lines. */
  wrap?: boolean;
  /** Inner padding — a single `Space` (all sides) or `[block, inline]`. */
  pad?: Space | [Space, Space];
  /** Render as `inline-flex` instead of `flex`. */
  inline?: boolean;
  style?: CSSProperties;
}

export function Row({ children, gap, align = "center", justify, wrap, pad: p, inline, style, ...rest }: RowProps) {
  return (
    <div
      style={{
        display: inline ? "inline-flex" : "flex",
        ...flexStyle({ gap, align, justify, wrap }),
        ...(p != null ? { padding: pad(p) } : {}),
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
}
