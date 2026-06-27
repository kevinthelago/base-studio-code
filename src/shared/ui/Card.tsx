// Card — the one framed-panel primitive (#card-unify). Owns the card "frame" (bg-panel + a
// 1px border + rounded corners + padding) that was re-expressed three ways across the app: the
// `.card` CSS class, ~10 feature `*-card` classes, and inline-styled framed divs. Use this for any
// bordered panel; pass a fully-laid-out `header` row above the body, tint the border with `tone`,
// and opt into hover/click with `interactive`. Layout-specific cards (grids, etc.) still add their
// own className on top.
import type { ReactNode, CSSProperties, MouseEvent } from "react";

const PAD = { sm: "10px 12px", md: "14px 16px" } as const;
const RADIUS = { sm: "var(--r-md)", md: "var(--r-lg)" } as const;

export interface CardProps {
  children: ReactNode;
  /** A fully-composed header row rendered above the body (caller controls its internal layout). */
  header?: ReactNode;
  /** Border accent color — e.g. "var(--accent)" / "var(--success)". Default = neutral border-soft. */
  tone?: string;
  /** Hover/press affordance (pointer + a transition); also implied when `onClick` is set. */
  interactive?: boolean;
  /** Padding + radius density. sm = compact body card · md (default) = the `.card` panel look. */
  pad?: "sm" | "md";
  className?: string;
  style?: CSSProperties;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
  title?: string;
}

export function Card({ children, header, tone, interactive, pad = "md", className, style, onClick, title }: CardProps) {
  return (
    <div
      className={className}
      title={title}
      onClick={onClick}
      style={{
        background: "var(--bg-panel)",
        border: "1px solid " + (tone ? `color-mix(in oklch, ${tone}, transparent 72%)` : "var(--border-soft)"),
        borderRadius: RADIUS[pad],
        padding: PAD[pad],
        cursor: interactive || onClick ? "pointer" : undefined,
        transition: interactive || onClick ? "border-color .1s, background .1s" : undefined,
        ...style,
      }}
    >
      {header}
      {children}
    </div>
  );
}
