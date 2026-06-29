// A two-step confirm button (#1527) — first click arms it (turns red), the second click within
// the same focus fires; blur disarms so a stray click is safe. Consolidates the copies across the
// settings panels. Two sizes preserve the call sites: "md" (8×14, alignSelf flex-start) and "sm"
// (5×10, inline). `danger` (default) styles it red; `disabled` dims + blocks it.

import { useState, type CSSProperties } from "react";

interface ConfirmButtonProps {
  label: string;
  armedLabel: string;
  onConfirm: () => void | Promise<void>;
  /** "md" (8×14, the reset cards) — the default — or "sm" (5×10, the inline list-row actions). */
  size?: "sm" | "md";
  disabled?: boolean;
  danger?: boolean;
  style?: CSSProperties;
}

export function ConfirmButton({
  label, armedLabel, onConfirm, size = "md", disabled = false, danger = true, style,
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);
  const sm = size === "sm";
  return (
    <button
      className="mono"
      disabled={disabled}
      onClick={() => { if (armed) { setArmed(false); void onConfirm(); } else { setArmed(true); } }}
      onBlur={() => setArmed(false)}
      style={{
        ...(sm ? {} : { alignSelf: "flex-start" }),
        padding: sm ? "5px 10px" : "8px 14px",
        borderRadius: 6,
        cursor: disabled ? "default" : "pointer",
        fontSize: sm ? 10.5 : 11.5,
        ...(disabled ? { opacity: 0.5 } : {}),
        background: armed && danger ? "var(--danger)" : "var(--bg-elev)",
        color: armed && danger ? "var(--bg-canvas)" : danger ? "var(--danger)" : "var(--fg)",
        border: "1px solid " + (armed && danger
          ? "var(--danger)"
          : danger ? "color-mix(in oklch, var(--danger), transparent 55%)" : "var(--border)"),
        ...style,
      }}
    >{armed ? armedLabel : label}</button>
  );
}
