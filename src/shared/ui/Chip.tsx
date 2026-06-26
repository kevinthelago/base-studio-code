// Chip — the shared "mono color-mix pill" (#1713): a small inline-flex badge whose own text
// `color` drives a translucent color-mix background + border. This is the one chip skeleton that
// was re-declared verbatim across the planner bodies (the connector-form InfoChip + the legitimacy
// ClearChip); it lives here once and the named variants delegate to it.
//
// Deliberately NOT folded in (folding would change their rendering — see #1635):
//   • ModeChip   — mixes a DIFFERENT oklch color than its text color.
//   • EntityChip / TypeChip — solid fills with `borderRadius: 4` (not 99), no color-mix.
//   • mcp scopeChips — className-based (`tag`/`ptag`) multi-element helper, not an inline pill.
// Those stay local to their feature.

import type { ReactNode } from "react";

const MONO = "var(--mono)";

export function Chip({
  color,
  children,
  bgAlpha = 88,
  borderAlpha = 72,
  gap = 6,
  padding = "3px 9px",
  radius = 99,
  fontSize = 9.5,
  alignSelf,
}: {
  /** The chip's text color; also the base hue mixed into the translucent bg + border. */
  color: string;
  children: ReactNode;
  /** transparent-% in the background color-mix (higher = fainter fill). */
  bgAlpha?: number;
  /** transparent-% in the border color-mix. */
  borderAlpha?: number;
  gap?: number;
  padding?: string;
  radius?: number;
  fontSize?: number;
  alignSelf?: "flex-start" | "center" | "flex-end" | "stretch";
}) {
  return (
    <span style={{
      display: "inline-flex", alignSelf, alignItems: "center", gap, fontFamily: MONO, fontSize, color,
      background: `color-mix(in oklch, ${color}, transparent ${bgAlpha}%)`,
      border: `1px solid color-mix(in oklch, ${color}, transparent ${borderAlpha}%)`,
      borderRadius: radius, padding,
    }}>{children}</span>
  );
}
