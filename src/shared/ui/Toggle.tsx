// A pill switch (#1527) — consolidates the toggle copied across settings, skills, and the planner
// deploy/integration bodies. Two sizes preserve the (drifted) call sites exactly: "md" (32×18, the
// settings panels) and "sm" (26×15, the skills rows + planner deploy/integration toggles). `tone`
// picks the ON-state color: "accent" (default) or "success" (the green deploy/integration toggles —
// a translucent track with a solid success border + knob). The track lights when `on`; the knob
// slides right.

import type { MouseEvent } from "react";

interface ToggleProps {
  on: boolean;
  onClick?: (e: MouseEvent) => void;
  /** "md" (32×18) — the default, used by the settings panels — or "sm" (26×15) for the skills rows. */
  size?: "sm" | "md";
  /** ON-state color: "accent" (default) or "success" (green). */
  tone?: "accent" | "success";
  className?: string;
  role?: string;
  ariaChecked?: boolean;
}

export function Toggle({ on, onClick, size = "md", tone = "accent", className, role, ariaChecked }: ToggleProps) {
  const success = tone === "success";
  // ON-state colors by tone. accent (default) is byte-identical to the original component; success
  // reproduces the green deploy/integration toggles (translucent track + solid success border/knob).
  const trackOn = success ? "color-mix(in oklch, var(--success), transparent 50%)" : "var(--accent)";
  const borderOn = success ? "var(--success)" : "transparent";
  const borderOff = success ? "var(--border-soft)" : "var(--border)";

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
          background: on ? trackOn : "var(--bg-elev2)",
          border: "1px solid " + (on ? borderOn : borderOff),
        }}
      >
        <span style={{
          position: "absolute", top: 1, left: on ? 12 : 1, width: 11, height: 11, borderRadius: "50%",
          background: on ? (success ? "var(--success)" : "var(--bg-canvas)") : "var(--fg-dim)",
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
        background: on ? trackOn : "var(--bg-elev2)",
        border: "1px solid " + (on ? borderOn : borderOff),
        transition: "background 0.15s", flex: "0 0 auto",
      }}
    >
      <span style={{
        width: 12, height: 12, borderRadius: "50%",
        background: on ? (success ? "var(--success)" : "#1a120a") : "var(--fg-dim)",
        marginLeft: on ? "auto" : 2, marginRight: on ? 2 : "auto",
        transition: "margin 0.15s",
      }} />
    </span>
  );
}
