// A pill switch (#1527) — consolidates the toggle copied across settings + skills surfaces. Two
// sizes preserve the (drifted) call sites exactly: "md" (32×18, the settings panels) and "sm"
// (26×15, the skills rows). The track is the accent color when `on`; the knob slides right.

import type { MouseEvent } from "react";

interface ToggleProps {
  on: boolean;
  onClick?: (e: MouseEvent) => void;
  /** "md" (32×18) — the default, used by the settings panels — or "sm" (26×15) for the skills rows. */
  size?: "sm" | "md";
  className?: string;
  role?: string;
  ariaChecked?: boolean;
}

export function Toggle({ on, onClick, size = "md", className, role, ariaChecked }: ToggleProps) {
  if (size === "sm") {
    return (
      <span
        className={className}
        onClick={onClick}
        role={role}
        aria-checked={ariaChecked}
        style={{
          width: 26, height: 15, borderRadius: 99, position: "relative", flex: "0 0 auto",
          cursor: onClick ? "pointer" : "default",
          background: on ? "var(--accent)" : "var(--bg-elev2)",
          border: "1px solid " + (on ? "transparent" : "var(--border)"),
        }}
      >
        <span style={{
          position: "absolute", top: 1, left: on ? 12 : 1, width: 11, height: 11, borderRadius: "50%",
          background: on ? "var(--bg-canvas)" : "var(--fg-dim)",
        }} />
      </span>
    );
  }
  return (
    <span
      className={className}
      onClick={onClick}
      role={role}
      aria-checked={ariaChecked}
      style={{
        display: "inline-flex", alignItems: "center",
        width: 32, height: 18, borderRadius: 99, cursor: "pointer",
        background: on ? "var(--accent)" : "var(--bg-elev2)",
        border: "1px solid " + (on ? "transparent" : "var(--border)"),
        transition: "background 0.15s", flex: "0 0 auto",
      }}
    >
      <span style={{
        width: 12, height: 12, borderRadius: "50%",
        background: on ? "#1a120a" : "var(--fg-dim)",
        marginLeft: on ? "auto" : 2, marginRight: on ? 2 : "auto",
        transition: "margin 0.15s",
      }} />
    </span>
  );
}
