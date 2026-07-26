// A pill switch (#1527) — consolidates the toggle copied across settings, skills, and the planner
// deploy/integration bodies. Three sizes preserve the (drifted) call sites exactly: "md" (32×18, the
// settings panels), "sm" (26×15, the skills rows + planner deploy/integration toggles), and "xs"
// (24×14, the compact Integrations "tools available to agents" grid, #1779). `tone` picks the
// ON-state color: "accent" (default) or "success" (the green deploy/integration toggles — a
// translucent track with a solid success border + knob). The track lights when `on`; the knob
// slides right.

import type { MouseEvent } from "react";
import { onEnterOrSpace } from "@/shared/ui/a11y";

interface ToggleProps {
  on: boolean;
  onClick?: (e: MouseEvent) => void;
  /** "md" (32×18, default — settings panels), "sm" (26×15, skills rows), or "xs" (24×14, compact grids). */
  size?: "xs" | "sm" | "md";
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

  // The switch's a11y bundle: when clickable, a keyboard-operable `switch` (role + focus + Enter/Space
  // activation ship WITH the click, #3775); a display-only toggle keeps just role/aria-checked. Bundled
  // so an interactive toggle can never be click-only, and identical across both size branches below.
  const switchProps = onClick
    ? { role: role ?? "switch", "aria-checked": ariaChecked ?? on, tabIndex: 0, onClick, onKeyDown: onEnterOrSpace(onClick) }
    : { role, "aria-checked": ariaChecked };

  // "sm" (26×15 / 11px knob) and "xs" (24×14 / 10px knob) share the absolute-knob track; only the
  // track/knob dimensions and the ON knob offset differ.
  if (size === "sm" || size === "xs") {
    const xs = size === "xs";
    const w = xs ? 24 : 26;
    const h = xs ? 14 : 15;
    const knob = xs ? 10 : 11;
    return (
      <span
        className={className}
        {...switchProps}
        style={{
          width: w, height: h, borderRadius: 99, position: "relative", flex: "0 0 auto",
          cursor: onClick ? "pointer" : "default",
          background: on ? trackOn : "var(--bg-elev2)",
          border: "1px solid " + (on ? borderOn : borderOff),
        }}
      >
        <span style={{
          position: "absolute", top: 1, left: on ? w - knob - 3 : 1, width: knob, height: knob, borderRadius: "50%",
          background: on ? (success ? "var(--success)" : "var(--bg-canvas)") : "var(--fg-dim)",
        }} />
      </span>
    );
  }
  return (
    <span
      className={className}
      {...switchProps}
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
        background: on ? (success ? "var(--success)" : "var(--on-accent)") : "var(--fg-dim)",
        marginLeft: on ? "auto" : 2, marginRight: on ? 2 : "auto",
        transition: "margin 0.15s",
      }} />
    </span>
  );
}
