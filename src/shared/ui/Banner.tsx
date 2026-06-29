import type { ReactNode, CSSProperties } from "react";
import "./banner.css";

export interface BannerProps {
  /** Colour tone. Default "neutral". */
  tone?: "neutral" | "info" | "success" | "warn" | "danger";
  /** A leading element — an icon box, dot, or glyph. */
  lead?: ReactNode;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/** Banner — the one inline callout strip: a toned, bordered row with an optional `lead` (icon/dot)
 *  and content. Replaces the per-feature `.sys-banner` (info), `.global-banner` (success), and
 *  `.inherit-note` (neutral) strips. */
export function Banner({ tone = "neutral", lead, children, className, style }: BannerProps) {
  return (
    <div className={`banner tone-${tone}` + (className ? ` ${className}` : "")} style={style}>
      {lead}
      {children}
    </div>
  );
}
