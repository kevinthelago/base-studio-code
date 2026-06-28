import type { CSSProperties, ReactNode } from "react";

const TONE: Record<string, string> = {
  accent: "var(--accent)", success: "var(--success)",
  danger: "var(--danger)", warning: "var(--warning)", info: "var(--info)",
};

export interface NoticeProps {
  /** Semantic tone — drives the tint, border, and text color. Default `accent`. */
  tone?: "accent" | "success" | "danger" | "warning" | "info";
  /** A leading status dot in the tone color (the readiness-banner look). */
  dot?: boolean;
  /** Content pushed to the far right (e.g. a dim caption or a small action). */
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/** A toned message box: a `color-mix` tint + matching border, mono text in the tone color, and an
 *  optional leading status dot. Consolidates the readiness/notice banners hand-rolled in the planner
 *  bodies (#1840). NOTE: this is only the genuine *message-box* pattern — the same `color-mix` idiom
 *  is used for chips, pills, and buttons elsewhere; those are intentionally distinct and not swept. */
export function Notice({ tone = "accent", dot, right, children, className, style }: NoticeProps) {
  const c = TONE[tone] ?? tone;
  return (
    <div className={className} style={{
      display: "flex", alignItems: "center", gap: 9, padding: "9px 13px",
      borderRadius: "var(--r-md)",
      background: `color-mix(in oklch, ${c}, transparent 90%)`,
      border: `1px solid color-mix(in oklch, ${c}, transparent 72%)`,
      color: c, fontFamily: "var(--mono)", fontSize: 11,
      ...style,
    }}>
      {dot && <span style={{ width: 7, height: 7, borderRadius: 99, background: c, flex: "0 0 auto" }} />}
      {children}
      {right != null && <><span style={{ flex: 1 }} />{right}</>}
    </div>
  );
}
