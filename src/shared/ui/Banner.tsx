import type { ReactNode, CSSProperties } from "react";
import "./banner.css";

export interface BannerProps {
  /** Colour tone. Default "neutral". */
  tone?: "neutral" | "info" | "success" | "warn" | "danger" | "accent";
  /** Full-width app/screen bar (square, border-bottom) vs the default inline rounded callout. */
  variant?: "inline" | "bar";
  /** A leading icon/element. */
  lead?: ReactNode;
  /** Shorthand for a tone-colored status dot as the lead. */
  dot?: boolean;
  /** Tone-colored text (the louder "status" look) instead of the default muted text. */
  loud?: boolean;
  /** Right-aligned content — a caption or action buttons. */
  right?: ReactNode;
  /** Renders a trailing dismiss ✕; invoked on click. */
  onDismiss?: () => void;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/** Banner — the one status strip. A toned, bordered row with an optional lead (icon or `dot`),
 *  content, a `right` slot, and an optional `onDismiss` ✕. The default is an inline rounded callout;
 *  `variant="bar"` makes it a full-width top-of-app/screen banner. Replaces the per-feature inline
 *  callouts, the `Notice` status box (`dot`/`loud`/`right`), AND the hand-rolled app banners. */
export function Banner({
  tone = "neutral", variant = "inline", lead, dot, loud, right, onDismiss, children, className, style,
}: BannerProps) {
  const cls = `banner tone-${tone}`
    + (variant === "bar" ? " bar" : "")
    + (loud ? " loud" : "")
    + (className ? ` ${className}` : "");
  return (
    <div className={cls} style={style}>
      {dot && <span className="banner-dot" />}
      {lead}
      {children}
      {(right != null || onDismiss) && <span style={{ flex: 1 }} />}
      {right}
      {onDismiss && <button className="banner-x" aria-label="Dismiss" onClick={onDismiss}>✕</button>}
    </div>
  );
}
