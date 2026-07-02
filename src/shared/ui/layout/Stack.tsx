// Stack — a vertical flex column with a gap (#2056). The one primitive for the ~200 hand-rolled
// `<div style={{ display: "flex", flexDirection: "column", gap: N }}>` divs across the app.
//
// Cross-axis default is the native `stretch` (align left unset), so converting an existing column
// div is lossless — pass `align` only when the div set `alignItems`. Any extra div prop (className,
// onClick, data-*, role, …) passes straight through, and a `style` override wins last.

import type { ReactNode, CSSProperties, ComponentPropsWithoutRef } from "react";
import { flexStyle, pad, type Space, type Align, type Justify } from "./space";

export interface StackProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  children?: ReactNode;
  /** Gap between children — a scale rung ("sm"/"md"/…) or raw px. */
  gap?: Space;
  /** Cross-axis (horizontal) alignment. Default = native `stretch`. */
  align?: Align;
  /** Main-axis (vertical) distribution. */
  justify?: Justify;
  /** Allow wrapping (rare for a column, but supported). */
  wrap?: boolean;
  /** Inner padding — a single `Space` (all sides) or `[block, inline]`. */
  pad?: Space | [Space, Space];
  /** Render as `inline-flex` instead of `flex`. */
  inline?: boolean;
  style?: CSSProperties;
}

export function Stack({ children, gap, align, justify, wrap, pad: p, inline, style, ...rest }: StackProps) {
  return (
    <div
      style={{
        display: inline ? "inline-flex" : "flex",
        flexDirection: "column",
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
