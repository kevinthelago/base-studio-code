import type { CSSProperties, ReactNode } from "react";

export interface SectionLabelProps {
  children: ReactNode;
  /** `md` (default): 10px / .06em — the common section/kv label. `sm`: 9px / .08em — the tighter
   *  caption used in dense KPI/analytics tiles. A raw px number is also legal (dense .08em tracking) —
   *  e.g. `size={9.5}`, the legacy `.ulabel` size (#2420). */
  size?: "sm" | "md" | number;
  /** `dim` (default, var(--fg-dim)) or `muted` (var(--fg-muted)). */
  tone?: "dim" | "muted";
  /** Optional right-aligned slot (#2420) — renders a space-between label row (label · right), the
   *  repeated "section header with a trailing note/control" idiom. `style` then styles the ROW. */
  right?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/** The uppercase mono micro-label — `fontFamily:var(--mono)` + `textTransform:uppercase` +
 *  letter-spacing + a dim/muted color — hand-rolled ~75× across the app. Collapses the four
 *  boilerplate style props into one primitive while keeping per-site spacing via `style` (#1837). */
export function SectionLabel({ children, size = "md", tone = "dim", right, className, style }: SectionLabelProps) {
  const label: CSSProperties = {
    fontSize: typeof size === "number" ? size : size === "sm" ? 9 : 10,
    letterSpacing: size === "md" ? ".06em" : ".08em",
    textTransform: "uppercase",
    color: tone === "muted" ? "var(--fg-muted)" : "var(--fg-dim)",
  };
  if (right == null) {
    return (
      <div className={`${className ?? ""} mono`} style={{ ...label, ...style }}>
        {children}
      </div>
    );
  }
  return (
    <div className={className} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, ...style }}>
      <div className="mono" style={label}>{children}</div>
      {right}
    </div>
  );
}
