import type { CSSProperties } from "react";

export interface ColorSwatchProps {
  /** The fill colour — any CSS colour, incl. `var()` / `color-mix()`. */
  color: string;
  /** Square side in px. Default 9. */
  size?: number;
  /** Corner radius in px. Default 2. */
  radius?: number;
  className?: string;
  style?: CSSProperties;
}

/** ColorSwatch — the small rounded colour square used as a category / profile / legend indicator.
 *  Replaces the inline `<span style={{ width:9, height:9, borderRadius:2, background }} />` repeated
 *  across the app. `flex:0 0` keeps it from shrinking inside flex rows. */
export function ColorSwatch({ color, size = 9, radius = 2, className, style }: ColorSwatchProps) {
  return (
    <span
      className={className}
      style={{ display: "inline-block", width: size, height: size, borderRadius: radius, background: color, flex: `0 0 ${size}px`, ...style }}
    />
  );
}
