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
  className?: string;
  style?: CSSProperties;
}

/** The shared "empty state + CTA" box: optional icon · title · description · action button(s) ·
 *  optional extra. Replaces the hand-rolled centered-stack that was copied across the connect
 *  screens, the skills no-match state, and the automations empty state (#1823). */
export function EmptyState({
  icon, iconVariant = "solid", title, description, actions, extra,
  variant = "inline", align = "center", className, style,
}: EmptyStateProps) {
  const isCard = variant === "card";
  const left = align === "left";

  const iconBox = icon != null && (
    <div style={{
      width: 54, height: 54, borderRadius: 14, margin: left ? "0 0 18px" : "0 auto 18px",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "var(--mono)", fontSize: 24,
      background: iconVariant === "solid" ? "var(--bg-elev)" : "transparent",
      border: `1px ${iconVariant === "dashed" ? "dashed" : "solid"} var(--border)`,
      color: iconVariant === "solid" ? "var(--accent)" : "var(--fg-dim)",
    }}>{icon}</div>
  );

  const body = (
    <>
      {iconBox}
      <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: isCard ? 18 : 15, fontWeight: 600 }}>
        {title}
      </h2>
      {description != null && (
        <p style={{ margin: "8px 0 0", color: "var(--fg-muted)", fontSize: isCard ? 13 : 12.5, lineHeight: 1.6, maxWidth: left ? undefined : 400 }}>
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
      justifyContent: "center", textAlign: left ? "left" : "center", padding: "40px 20px", ...style,
    }}>
      {body}
    </div>
  );
}
