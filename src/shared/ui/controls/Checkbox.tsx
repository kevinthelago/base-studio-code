import type { KeyboardEvent } from "react";

export interface CheckboxProps {
  checked: boolean;
  /** When provided, the box is self-interactive (click + Space/Enter, `role="checkbox"`). Omit when a
   *  parent row already owns the toggle — the box is then presentational and the row handles the click. */
  onChange?: () => void;
  /** Box edge in px (default 14). The ✓ scales with it. */
  size?: number;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}

/**
 * The shared checkbox primitive (#1891) — the small ✓ square consolidated from the hand-rolled
 * `<span style={{…}}>` copies (skills facets + card select). Sibling to `Toggle` (pill switch) and
 * `SegmentedControl`. Presentational by default (a parent row toggles); pass `onChange` to make the
 * box itself interactive + keyboard-operable.
 */
export function Checkbox({ checked, onChange, size = 14, disabled, className, "aria-label": ariaLabel }: CheckboxProps) {
  const interactive = !!onChange && !disabled;
  const onKeyDown = interactive
    ? (e: KeyboardEvent) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); onChange!(); } }
    : undefined;
  return (
    <span
      className={className}
      aria-label={ariaLabel}
      {...(interactive
        ? { role: "checkbox" as const, "aria-checked": checked, tabIndex: 0, onClick: () => onChange!(), onKeyDown }
        : {})}
      style={{
        width: size, height: size, flex: "0 0 auto", borderRadius: 4,
        border: "1px solid " + (checked ? "var(--accent)" : "var(--border)"),
        background: checked ? "var(--accent)" : "transparent",
        color: "var(--bg-canvas)", fontSize: Math.round(size * 0.64),
        display: "flex", alignItems: "center", justifyContent: "center",
        cursor: interactive ? "pointer" : undefined, opacity: disabled ? 0.4 : undefined,
      }}
    >
      {checked ? "✓" : ""}
    </span>
  );
}
