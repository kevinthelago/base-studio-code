import type { CSSProperties } from "react";

export interface FillBarProps {
  /** Fill fraction 0..1 (clamped). */
  value: number;
  /** Fill color. Default `var(--accent)`. */
  color?: string;
  /** Track (background) color. Default `var(--bg-elev2)`. */
  track?: string;
  /** Bar height in px. Default 8. */
  height?: number;
  /** Pill radius (99) when true (default), square when false. */
  rounded?: boolean;
  className?: string;
  /** Applied to the track element (e.g. flex sizing in a multi-segment row). */
  style?: CSSProperties;
}

/** A horizontal track with an inner width-driven fill — the progress/allocation bar hand-rolled
 *  across the analytics tabs, contributor lists, and planner deploy/scan views (#1838). Compose
 *  several side-by-side for a multi-segment bar. */
export function FillBar({ value, color = "var(--accent)", track = "var(--bg-elev2)", height = 8, rounded = true, className, style }: FillBarProps) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  const radius = rounded ? 99 : 0;
  return (
    <div className={className} style={{ height, borderRadius: radius, background: track, overflow: "hidden", ...style }}>
      <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: radius }} />
    </div>
  );
}
