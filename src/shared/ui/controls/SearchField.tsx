import type { CSSProperties, KeyboardEvent, ReactNode } from "react";

export interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  "aria-label"?: string;
  /** Leading glyph. Defaults to the search icon; pass `null` to omit (e.g. a paste box). */
  icon?: ReactNode;
  /** Optional trailing slot — a result count, a `⌘K` kbd, etc. */
  trailing?: ReactNode;
  /** Container style overrides (bg, height, radius, flex/width) merged over the base look. */
  style?: CSSProperties;
  className?: string;
  /** Input style overrides (e.g. a per-site font-size). */
  inputStyle?: CSSProperties;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
}

const boxBase: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  height: 32,
  padding: "0 11px",
  background: "var(--bg-soft)",
  border: "1px solid var(--border)",
  borderRadius: 8,
};

const inputBase: CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: "none",
  border: "none",
  color: "var(--fg)",
  fontSize: 12.5,
  fontFamily: "inherit",
  outline: "none",
};

/**
 * A small bordered search box: a leading `⌕` glyph, a bare `<input>`, and an
 * optional `trailing` slot. Consolidates the icon+borderless-input pattern that
 * was hand-rolled at several sites (#2708).
 */
export function SearchField({
  value,
  onChange,
  placeholder,
  icon = <span style={{ color: "var(--fg-dim)", fontSize: 13 }}>⌕</span>,
  trailing,
  style,
  className,
  inputStyle,
  onKeyDown,
  "aria-label": ariaLabel,
}: SearchFieldProps) {
  return (
    <div className={className} style={{ ...boxBase, ...style }}>
      {icon}
      {/* eslint-disable-next-line no-restricted-syntax -- this primitive intentionally wraps a bare
          borderless <input>; Field/TextField impose a labelled .field layout that doesn't fit an
          inline search box. This is the ONE justified bare input, centralized here. */}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel}
        style={{ ...inputBase, ...inputStyle }}
      />
      {trailing}
    </div>
  );
}
