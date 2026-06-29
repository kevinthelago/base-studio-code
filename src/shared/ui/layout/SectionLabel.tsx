import type { CSSProperties, ReactNode } from "react";

export interface SectionLabelProps {
  children: ReactNode;
  /** `md` (default): 10px / .06em — the common section/kv label. `sm`: 9px / .08em — the tighter
   *  caption used in dense KPI/analytics tiles. Pass `style={{ fontSize }}` to override the long tail. */
  size?: "sm" | "md";
  /** `dim` (default, var(--fg-dim)) or `muted` (var(--fg-muted)). */
  tone?: "dim" | "muted";
  className?: string;
  style?: CSSProperties;
}

/** The uppercase mono micro-label — `fontFamily:var(--mono)` + `textTransform:uppercase` +
 *  letter-spacing + a dim/muted color — hand-rolled ~75× across the app. Collapses the four
 *  boilerplate style props into one primitive while keeping per-site spacing via `style` (#1837). */
export function SectionLabel({ children, size = "md", tone = "dim", className, style }: SectionLabelProps) {
  return (
    <div className={className} style={{
      fontFamily: "var(--mono)",
      fontSize: size === "sm" ? 9 : 10,
      letterSpacing: size === "sm" ? ".08em" : ".06em",
      textTransform: "uppercase",
      color: tone === "muted" ? "var(--fg-muted)" : "var(--fg-dim)",
      ...style,
    }}>
      {children}
    </div>
  );
}
