// space.ts — the shared vocabulary the layout kit (Stack/Row/Spacer) is built on (#2056).
//
// One spacing scale, one alignment mapping. The named `Space` sizes mirror the `--sp-*` CSS
// tokens in tokens.css (xs=4 … xl=24) so the kit and the stylesheet speak the same scale — but
// a raw pixel number is always legal too (the very common `gap:10` stays `gap={10}`), which
// keeps mechanical `<div style>` → primitive conversions lossless.

import type { CSSProperties } from "react";

/** A spacing value: a named scale rung, or a raw pixel number for the off-scale cases. */
export type Space = number | "xs" | "sm" | "md" | "lg" | "xl";

/** Cross-axis / main-axis alignment, friendly names (map to their flexbox values). */
export type Align = "start" | "center" | "end" | "baseline" | "stretch";
export type Justify = "start" | "center" | "end" | "between" | "around" | "evenly";

const SCALE: Record<Exclude<Space, number>, number> = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };

const ALIGN: Record<Align, CSSProperties["alignItems"]> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  baseline: "baseline",
  stretch: "stretch",
};

const JUSTIFY: Record<Justify, CSSProperties["justifyContent"]> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  between: "space-between",
  around: "space-around",
  evenly: "space-evenly",
};

/** Resolve a `Space` to a pixel number (named rung → scale, number → itself). */
export function space(v: Space | undefined): number | undefined {
  if (v == null) return undefined;
  return typeof v === "number" ? v : SCALE[v];
}

/** Resolve a padding shorthand: a single `Space` (all sides) or `[block, inline]`. */
export function pad(v: Space | [Space, Space] | undefined): CSSProperties["padding"] {
  if (v == null) return undefined;
  if (Array.isArray(v)) return `${space(v[0])}px ${space(v[1])}px`;
  const n = space(v);
  return n == null ? undefined : `${n}px`;
}

export interface FlexOptions {
  gap?: Space;
  align?: Align;
  justify?: Justify;
  wrap?: boolean;
}

/** Build the flex-layout portion of a style object shared by Stack and Row. */
export function flexStyle({ gap, align, justify, wrap }: FlexOptions): CSSProperties {
  const s: CSSProperties = {};
  const g = space(gap);
  if (g != null) s.gap = g;
  if (align) s.alignItems = ALIGN[align];
  if (justify) s.justifyContent = JUSTIFY[justify];
  if (wrap) s.flexWrap = "wrap";
  return s;
}
