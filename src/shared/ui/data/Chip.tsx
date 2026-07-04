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

import type { ReactNode, CSSProperties } from "react";
import { Skeleton } from "@/shared/ui/feedback/Skeleton";
import "./chip.css";

const MONO = "var(--mono)";

export type ChipTone = "neutral" | "accent" | "success" | "info" | "danger";

/** Chip — the one pill (#1874). Two paths:
 *  - `tone` (default): a semantic class-based pill (theme-able via chip.css) — absorbs `.tag` + the
 *    feature badges (mode/origin/…).
 *  - `color`: the translucent color-mix pill rendered inline — for DYNAMIC colours (GitHub labels,
 *    profile colours). Overrides `tone`; the original Chip behaviour, preserved. */
export function Chip({
  children,
  tone = "neutral",
  color,
  dot,
  size = "sm",
  title,
  className,
  style,
  bgAlpha = 88,
  borderAlpha = 72,
  gap = 6,
  padding,
  radius = 99,
  fontSize,
  alignSelf,
  loading,
  loadingWidth,
}: {
  children: ReactNode;
  /** Render the chip LOADING (#2302): a shimmer pill the shape of a chip. `loadingWidth` sets its px width. */
  loading?: boolean;
  loadingWidth?: number;
  /** Semantic tone (class-based). Ignored when `color` is set. */
  tone?: ChipTone;
  /** An explicit colour — renders the inline color-mix pill (dynamic colours). Overrides `tone`. */
  color?: string;
  /** A leading dot in the current colour. */
  dot?: boolean;
  /** "xs" (8.5px) · "sm" (10px, default, = the old `.tag`) · "md" (10.5px). */
  size?: "xs" | "sm" | "md";
  title?: string;
  className?: string;
  style?: CSSProperties;
  // ── inline `color`-path knobs (the dynamic-colour pill) ──
  bgAlpha?: number;
  borderAlpha?: number;
  gap?: number;
  padding?: string;
  radius?: number;
  fontSize?: number;
  alignSelf?: "flex-start" | "center" | "flex-end" | "stretch";
}) {
  if (loading) {
    const h = size === "md" ? 18 : size === "xs" ? 15 : 17;
    return <Skeleton w={loadingWidth ?? 48} h={h} radius={radius} style={{ display: "inline-block", verticalAlign: "middle", alignSelf, ...style }} />;
  }
  if (color) {
    return (
      <span title={title} className={className} style={{
        display: "inline-flex", alignSelf, alignItems: "center", gap, fontFamily: MONO,
        fontSize: fontSize ?? 9.5, color,
        background: `color-mix(in oklch, ${color}, transparent ${bgAlpha}%)`,
        border: `1px solid color-mix(in oklch, ${color}, transparent ${borderAlpha}%)`,
        borderRadius: radius, padding: padding ?? "3px 9px", ...style,
      }}>
        {dot && <span style={{ width: 5, height: 5, borderRadius: "50%", background: color, flex: "0 0 5px" }} />}
        {children}
      </span>
    );
  }
  return (
    <span title={title} style={style} className={`chip tone-${tone} size-${size}` + (className ? ` ${className}` : "")}>
      {dot && <span className="chip-dot" />}
      {children}
    </span>
  );
}

/** Map a legacy `.tag` modifier class (green/amber/info/danger) to a Chip tone. */
export function tagTone(cls?: string): ChipTone {
  return cls === "green" ? "success" : cls === "amber" ? "accent" : cls === "info" ? "info" : cls === "danger" ? "danger" : "neutral";
}
