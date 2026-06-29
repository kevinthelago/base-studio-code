// One canonical back control (#1752) — replaces the ad-hoc text-arrow "←" strings that were scattered
// across the planner. Always renders the `chevron_left` SVG (never the literal "←"), so every back
// affordance looks the same.
//
//   variant="icon"  — a boxed 30×30 chevron button (the planner-header design). `label` is ignored.
//   variant="text"  — a chevron + text label (e.g. "portfolio", "fleet", "back"). The call site keeps
//                     its own look by passing `className`/`style` (e.g. "nav-btn", "btn ghost", or the
//                     inline header-link style); this component only standardizes the glyph + layout.
import type { CSSProperties } from "react";
import { Ic } from "@/shared/ui/icons";

interface BackButtonProps {
  onClick: () => void;
  /** Required — back buttons must be screen-reader labelled (the bare chevron isn't). */
  "aria-label": string;
  variant?: "icon" | "text";
  /** Text-variant label rendered after the chevron. */
  label?: string;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Chevron px size (defaults: 18 for icon, 14 for text). */
  size?: number;
  title?: string;
}

export function BackButton({
  onClick, "aria-label": ariaLabel, variant = "text", label, disabled, className, style, size, title,
}: BackButtonProps) {
  if (variant === "icon") {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={ariaLabel}
        title={title ?? ariaLabel}
        className={className}
        style={{
          width: 30, height: 30, flex: "0 0 30px",
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          background: "var(--bg-elev)", border: "1px solid var(--border)",
          borderRadius: "var(--r-md)", cursor: "pointer",
          color: "var(--fg)", padding: 0, marginRight: 2,
          ...style,
        }}
      ><Ic n="chevron_left" size={size ?? 18} /></button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      title={title}
      className={className}
      style={{ display: "inline-flex", alignItems: "center", gap: 4, ...style }}
    >
      <Ic n="chevron_left" size={size ?? 14} />
      {label}
    </button>
  );
}
