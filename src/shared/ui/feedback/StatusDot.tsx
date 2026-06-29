// StatusDot (#1777) — one small colored status dot, replacing the hand-prepended `●` glyph and the
// ad-hoc inline circle <span>s scattered across the app. Defaults to `currentColor` so dropping it
// into a `.tag`/`.tag.green`/etc. inherits that element's color exactly (the `●` glyph did the same),
// or pass a semantic `state` to use the shared `--state-*` tokens, or an explicit `color`.
import type { CSSProperties } from "react";

/** Canonical activity states → their design token (tokens.css `--state-*`). */
export type DotState = "run" | "wait" | "idle" | "stopped";

const STATE_COLOR: Record<DotState, string> = {
  run: "var(--state-run)",
  wait: "var(--state-wait)",
  idle: "var(--state-idle)",
  stopped: "var(--state-stopped)",
};

export interface StatusDotProps {
  /** Semantic state → its `--state-*` token. Ignored when `color` is set. */
  state?: DotState;
  /** Explicit color. Defaults to `currentColor` (inherits the surrounding tag/text color). */
  color?: string;
  /** Diameter in px (default 6). */
  size?: number;
  /** Pulse animation — a live "running" indicator. */
  pulse?: boolean;
  /** Native tooltip; when set, the dot is exposed to AT, otherwise it's `aria-hidden`. */
  title?: string;
  style?: CSSProperties;
}

export function StatusDot({ state, color, size = 6, pulse = false, title, style }: StatusDotProps) {
  const background = color ?? (state ? STATE_COLOR[state] : "currentColor");
  return (
    <span
      {...(title ? { title } : { "aria-hidden": true })}
      style={{
        display: "inline-block",
        width: size,
        height: size,
        flex: `0 0 ${size}px`,
        borderRadius: "50%",
        background,
        ...(pulse ? { animation: "pulse 1.4s ease-in-out infinite" } : {}),
        ...style,
      }}
    />
  );
}
