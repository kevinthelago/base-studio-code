// Card — the one framed-panel primitive (#card-unify). Renders the shared `.card` class (bg-panel +
// 1px border + rounded corners + padding, from tokens.css) so it's a drop-in for the ~100 raw
// `<div className="card">` divs across the app — feature CSS that targets `.card` as an ancestor
// (`.card .head`, `.prof-list.card`, …) keeps working untouched. On top of the class it adds a thin
// layer: a `header` row, a `tone` border tint, an `interactive`/`onClick` hover affordance, and a
// compact `pad="sm"` density. Layout-specific cards still add their own className on top.
import type { ReactNode, CSSProperties, MouseEvent } from "react";

export interface CardProps {
  children: ReactNode;
  /** A fully-composed header row rendered above the body (caller controls its internal layout). */
  header?: ReactNode;
  /** Border accent color — e.g. "var(--accent)" / "var(--success)". Default = the `.card` border. */
  tone?: string;
  /** Hover/press affordance (pointer + a transition); also implied when `onClick` is set. */
  interactive?: boolean;
  /** "sm" overrides `.card`'s padding for a compact body card; default keeps the `.card` look. */
  pad?: "sm";
  className?: string;
  style?: CSSProperties;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
  title?: string;
}

export function Card({ children, header, tone, interactive, pad, className, style, onClick, title }: CardProps) {
  return (
    <div
      className={"card" + (className ? ` ${className}` : "")}
      title={title}
      onClick={onClick}
      style={{
        ...(tone ? { borderColor: `color-mix(in oklch, ${tone}, transparent 72%)` } : {}),
        ...(interactive || onClick ? { cursor: "pointer", transition: "border-color .1s, background .1s" } : {}),
        ...(pad === "sm" ? { padding: "10px 12px" } : {}),
        ...style,
      }}
    >
      {header}
      {children}
    </div>
  );
}
