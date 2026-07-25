// Card — the one framed-panel primitive (#card-unify). Renders the shared `.card` class (bg-panel +
// 1px border + rounded corners + padding, from tokens.css) so it's a drop-in for the ~100 raw
// `<div className="card">` divs across the app — feature CSS that targets `.card` as an ancestor
// (`.card .head`, `.prof-list.card`, …) keeps working untouched. On top of the class it adds a thin
// layer: an optional canonical head (`title` + `hint` + `right` → an h3 row, absorbing the old
// `SettingsCardHead`) OR a fully-custom `header` node, a `tone` border tint, an `interactive`/`onClick`
// hover affordance, and a compact `pad="sm"` density. Layout cards still add their own className.
import type { ReactNode, CSSProperties, MouseEvent } from "react";
import { SkeletonText } from "@/shared/ui/feedback/Skeleton";
import { clickable } from "@/shared/ui/a11y";

export interface CardProps {
  children: ReactNode;
  /** Render the card LOADING (#2302): keep the frame + head, replace the body with a skeleton the
   *  same shape as its content. `loadingLines` tunes the body skeleton's line count (default 3). */
  loading?: boolean;
  loadingLines?: number;
  /** Canonical head: a title (h3) rendered above the body. The one-stop "card with a title". */
  title?: ReactNode;
  /** Inline hint beside the title (canonical head only). */
  hint?: ReactNode;
  /** Right-aligned control in the canonical head row. */
  right?: ReactNode;
  /** Override the canonical head's bottom margin (px). Default 12. */
  headMb?: number;
  /** A fully-composed header node — for heads that aren't the canonical h3 row. Wins over `title`. */
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
  /** The HTML `title` attribute (hover tooltip). */
  tooltip?: string;
}

export function Card({ children, loading, loadingLines = 3, title, hint, right, headMb, header, tone, interactive, pad, className, style, onClick, tooltip }: CardProps) {
  const head = header ?? (title != null ? (
    <div style={{ display: "flex", alignItems: "baseline", marginBottom: headMb ?? 12, gap: 10 }}>
      <h3 style={{ margin: 0 }}>{title}</h3>
      {hint && <span className="hint">{hint}</span>}
      {right && <><span style={{ flex: 1 }} />{right}</>}
    </div>
  ) : null);
  return (
    <div
      className={"card" + (className ? ` ${className}` : "")}
      title={tooltip}
      {...clickable(onClick)}
      style={{
        ...(tone ? { borderColor: `color-mix(in oklch, ${tone}, transparent 72%)` } : {}),
        ...(interactive || onClick ? { cursor: "pointer", transition: "border-color .1s, background .1s" } : {}),
        ...(pad === "sm" ? { padding: "10px 12px" } : {}),
        ...style,
      }}
    >
      {head}
      {loading ? <SkeletonText lines={loadingLines} /> : children}
    </div>
  );
}
