import type { CSSProperties, ReactNode } from "react";

export interface EmptyStateProps {
  /** Glyph/char or node shown in the icon box above the title. Omit for no icon. */
  icon?: ReactNode;
  /** `solid` (default): elev background, accent glyph — the onboarding/"connect" look.
   *  `dashed`: dashed border, dim glyph — the "nothing here / no match" look. */
  iconVariant?: "solid" | "dashed";
  title: ReactNode;
  description?: ReactNode;
  /** Action button(s). Composed by the caller so per-site button semantics (disabled,
   *  danger tint, `btn primary`, full-width) stay intact rather than being re-modelled. */
  actions?: ReactNode;
  /** Extra content rendered below the actions (e.g. a "scopes requested" box). */
  extra?: ReactNode;
  /** `inline` (default): a centered column that fills its flex parent (in-page empty states).
   *  `card`: a bordered, shadowed 460px panel (the standalone onboarding/connect screens). */
  variant?: "inline" | "card";
  /** Content alignment. `center` (default) for the symmetric empty states; `left` for the
   *  richer GitHub-page connect card, which left-aligns its icon, copy, and CTA. */
  align?: "center" | "left";
  /** `md` (default) — the full page/section empty state. `sm` — a compact footprint (smaller icon,
   *  title, padding) for an EMPTY state sitting inside a card body (#2234). */
  size?: "sm" | "md";
  className?: string;
  style?: CSSProperties;
}

/** The shared "empty state + CTA" box: optional icon · title · description · action button(s) ·
 *  optional extra. Replaces the hand-rolled centered-stack that was copied across the connect
 *  screens, the skills no-match state, and the automations empty state (#1823). */
export function EmptyState({
  icon, iconVariant = "solid", title, description, actions, extra,
  variant = "inline", align = "center", size = "md", className, style,
}: EmptyStateProps) {
  const isCard = variant === "card";
  const left = align === "left";
  const sm = size === "sm";

  const iconBox = icon != null && (
    <div className="mono" style={{
      width: sm ? 38 : 54, height: sm ? 38 : 54, borderRadius: sm ? 11 : 14,
      margin: left ? `0 0 ${sm ? 12 : 18}px` : `0 auto ${sm ? 12 : 18}px`,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: sm ? 17 : 24,
      background: iconVariant === "solid" ? "var(--bg-elev)" : "transparent",
      border: `1px ${iconVariant === "dashed" ? "dashed" : "solid"} var(--border)`,
      color: iconVariant === "solid" ? "var(--accent)" : "var(--fg-dim)",
    }}>{icon}</div>
  );

  const body = (
    <>
      {iconBox}
      <h2 className="mono" style={{ margin: 0, fontSize: isCard ? 18 : sm ? 12.5 : 15, fontWeight: 600 }}>
        {title}
      </h2>
      {description != null && (
        <p style={{ margin: `${sm ? 6 : 8}px 0 0`, color: "var(--fg-muted)", fontSize: isCard ? 13 : sm ? 11 : 12.5, lineHeight: 1.55, maxWidth: left ? undefined : 400 }}>
          {description}
        </p>
      )}
      {actions != null && (
        <div style={{ display: "flex", gap: 8, justifyContent: left ? "flex-start" : "center", marginTop: 18, width: isCard ? "100%" : undefined }}>
          {actions}
        </div>
      )}
      {extra}
    </>
  );

  if (isCard) {
    return (
      <div className={className} style={{
        width: 460, padding: "36px 36px 32px",
        background: "var(--bg-panel)", border: "1px solid var(--border-soft)",
        borderRadius: 12, boxShadow: "0 18px 50px rgba(0,0,0,0.4)", textAlign: left ? "left" : "center",
        ...style,
      }}>
        {body}
      </div>
    );
  }
  return (
    <div className={className} style={{
      flex: 1, display: "flex", flexDirection: "column",
      alignItems: left ? "flex-start" : "center",
      justifyContent: "center", textAlign: left ? "left" : "center", padding: sm ? "22px 16px" : "40px 20px", ...style,
    }}>
      {body}
    </div>
  );
}
