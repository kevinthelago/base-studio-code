// Grid — a CSS grid container with template tracks and a gap (#2058). The one primitive for the
// ~77 hand-rolled `<div style={{ display: "grid", gridTemplateColumns: …, gap: N }}>` divs across
// the app. The common templates are `1fr 1fr` (9×), `repeat(N, 1fr)`, `1fr auto`, and bespoke pixel
// tracks — so `cols` takes EITHER a number `n` (→ `repeat(n, 1fr)`, the even-split shorthand) OR an
// explicit template string passed straight through (`"1fr auto"`, `"50px 1fr auto 50px"`).
//
// Alignment reuses the shared layout vocabulary (`space.ts`): `align` → `alignItems` (cell cross-axis
// alignment) and `justify` → `justifyContent` (inline-axis track distribution, so the full Justify
// vocabulary incl. between/around/evenly is valid). Any extra div prop (className, onClick,
// data-*, …) passes straight through, and a `style` override wins last — so mechanical
// `<div style>` → `<Grid>` conversions stay lossless.

import type { ReactNode, CSSProperties, ComponentPropsWithoutRef } from "react";
import { space, alignValue, justifyValue, type Space, type Align, type Justify } from "./space";

/** A track spec: a number `n` (→ `repeat(n, 1fr)`) or an explicit template string (passed through). */
type Tracks = number | string;

function tracks(v: Tracks | undefined): string | undefined {
  if (v == null) return undefined;
  return typeof v === "number" ? `repeat(${v}, 1fr)` : v;
}

export interface GridProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  children?: ReactNode;
  /** Columns — a number `n` (even `repeat(n, 1fr)` split) or an explicit `gridTemplateColumns` string. */
  cols?: Tracks;
  /** Rows — a number `n` (even `repeat(n, 1fr)` split) or an explicit `gridTemplateRows` string. */
  rows?: Tracks;
  /** Gap between cells — a scale rung ("sm"/"md"/…) or raw px. */
  gap?: Space;
  /** Cross-axis (block) item alignment → `alignItems`. */
  align?: Align;
  /** Inline-axis track distribution → `justifyContent`. */
  justify?: Justify;
  /** Render as `inline-grid` instead of `grid`. */
  inline?: boolean;
  style?: CSSProperties;
}

export function Grid({ children, cols, rows, gap, align, justify, inline, style, ...rest }: GridProps) {
  const g = space(gap);
  return (
    <div
      style={{
        display: inline ? "inline-grid" : "grid",
        ...(cols != null ? { gridTemplateColumns: tracks(cols) } : {}),
        ...(rows != null ? { gridTemplateRows: tracks(rows) } : {}),
        ...(g != null ? { gap: g } : {}),
        ...(align ? { alignItems: alignValue(align) } : {}),
        ...(justify ? { justifyContent: justifyValue(justify) } : {}),
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
}
