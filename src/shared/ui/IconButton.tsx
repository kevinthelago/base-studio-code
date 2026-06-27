// IconButton (#1753) — the one button for icon-glyph actions (close / remove / cancel), replacing the
// five wrappers (`.x`, the misspelled-and-unstyled `.iconbtn`, `.btn ghost` at three sizes, `.mini`,
// fully-inline) and two glyphs (`×` U+00D7 vs `✕` U+2715) the app had hand-rolled. Renders the
// canonical close glyph by default; `aria-label` is REQUIRED so every icon button is accessible.
import type { ReactNode, CSSProperties, MouseEvent } from "react";

/** The one canonical close/dismiss glyph. */
export const CLOSE_GLYPH = "✕";

export interface IconButtonProps {
  /** Required — icon buttons have no text, so they must carry an accessible name. */
  "aria-label": string;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  /** The glyph/icon; defaults to the canonical close glyph. */
  children?: ReactNode;
  /** Hit-area size: md = 24px (default, modal/panel/banner headers) · sm = 20px · xs = 16px (inline chip removers). */
  size?: "md" | "sm" | "xs";
  /** Red hover (destructive). */
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  className?: string;
  style?: CSSProperties;
}

export function IconButton({
  "aria-label": ariaLabel, onClick, children, size = "md", danger, disabled, title, className, style,
}: IconButtonProps) {
  const cls = ["icon-btn", size !== "md" && size, danger && "danger", className].filter(Boolean).join(" ");
  return (
    <button type="button" className={cls} aria-label={ariaLabel} title={title ?? ariaLabel} onClick={onClick} disabled={disabled} style={style}>
      {children ?? CLOSE_GLYPH}
    </button>
  );
}
