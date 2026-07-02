// Box — the generic styled container primitive (#2079). The catch-all so features never write a raw
// `<div>`: every arbitrary styled/plain wrapper (a padded panel, a positioned overlay, a bordered
// box, a className-only div) becomes a `<Box>`. Stack/Row/Grid stay the choice for flex/grid layout,
// Text for text, Card for framed panels — Box is everything else.
//
// Moderate token-backed shorthands (`pad`/`bg`/`border`/`radius`/`shadow`) cover the high-frequency
// inline styles; anything else goes through `style` (which wins last). Polymorphic via `as` (default
// div; e.g. section/aside/ul/span). Any extra prop (className, onClick, data-*, ref-free DOM attrs)
// passes straight through.

import type { CSSProperties, ReactNode, ElementType } from "react";
import { pad as padValue, type Space } from "./space";

/** Corner radius — a token rung (--r-*) or raw px. */
export type Radius = "sm" | "md" | "lg" | number;
/** Elevation — a --shadow-* rung. */
export type Shadow = "sm" | "md" | "lg" | "xl";
/** Border — true → --stroke, "soft" → --stroke-soft, or a color string → `1px solid <color>`. */
export type BorderProp = boolean | "soft" | string;

const RADIUS: Record<"sm" | "md" | "lg", string> = { sm: "var(--r-sm)", md: "var(--r-md)", lg: "var(--r-lg)" };

function radiusValue(r: Radius | undefined): string | undefined {
  if (r == null) return undefined;
  return typeof r === "number" ? `${r}px` : RADIUS[r];
}

function borderValue(b: BorderProp | undefined): string | undefined {
  if (b == null || b === false) return undefined;
  if (b === true) return "var(--stroke)";
  if (b === "soft") return "var(--stroke-soft)";
  return `1px solid ${b}`;
}

export interface BoxProps {
  children?: ReactNode;
  /** The rendered element (default "div"; e.g. section/aside/ul/span). */
  as?: ElementType;
  /** Inner padding — a space rung/px, or a [block, inline] pair. */
  pad?: Space | [Space, Space];
  /** Background color/token (e.g. "var(--bg-elev)"). */
  bg?: string;
  /** Border — true → --stroke, "soft" → --stroke-soft, or a color → `1px solid <color>`. */
  border?: BorderProp;
  /** Corner radius — a rung (sm/md/lg → --r-*) or raw px. */
  radius?: Radius;
  /** Drop shadow — a --shadow-* rung (sm/md/lg/xl). */
  shadow?: Shadow;
  className?: string;
  style?: CSSProperties;
  /** Any other prop passes through to the rendered element. */
  [key: string]: unknown;
}

export function Box({ children, as: As = "div", pad, bg, border, radius, shadow, style, ...rest }: BoxProps) {
  const p = padValue(pad);
  const b = borderValue(border);
  const r = radiusValue(radius);
  return (
    <As
      style={{
        ...(p != null ? { padding: p } : {}),
        ...(bg != null ? { background: bg } : {}),
        ...(b != null ? { border: b } : {}),
        ...(r != null ? { borderRadius: r } : {}),
        ...(shadow != null ? { boxShadow: `var(--shadow-${shadow})` } : {}),
        ...style,
      }}
      {...rest}
    >
      {children}
    </As>
  );
}
