// Code — the one read-only monospace code/prompt block (#2102). A tiny framed `<pre>` that bakes in
// the "preStyle" recipe re-declared verbatim across the app (the kickoff-prompt preview + lane-context
// blocks in the focused agent editor, and their kin): a scrollable, mono, muted, canvas-tinted panel.
//
// It is DISPLAY-ONLY — it renders text/JSON/logs, never a syntax-highlighted or interactive block
// (per-line diffs, the crash boundary's kit-free `<pre>`, and file viewers keep their own markup).
// Every prop is opt-in: `maxHeight` caps the scroll height, `wrap` toggles soft-wrapping (on) vs a
// horizontal scroll (`whiteSpace: "pre"`), `tone` picks the foreground color, and `className`/`style`
// pass through with `style` winning last so any single value stays overridable.

import type { CSSProperties, ReactNode } from "react";
import { toneColor, type Tone } from "../typography/type";

export interface CodeProps {
  children?: ReactNode;
  /** Max scroll height in px before the block scrolls (default 150). */
  maxHeight?: number;
  /** Soft-wrap long lines (`pre-wrap`, default) vs a horizontal scroll (`pre`). */
  wrap?: boolean;
  /** Foreground color tone (default "muted" → var(--fg-muted)). */
  tone?: Tone;
  className?: string;
  style?: CSSProperties;
}

export function Code({ children, maxHeight = 150, wrap = true, tone = "muted", className, style }: CodeProps) {
  return (
    <pre
      className={className}
      style={{
        margin: 0,
        maxHeight,
        overflow: "auto",
        whiteSpace: wrap ? "pre-wrap" : "pre",
        wordBreak: "break-word",
        fontFamily: "var(--mono)",
        fontSize: 10,
        lineHeight: 1.5,
        color: toneColor(tone),
        background: "var(--bg-canvas)",
        border: "1px solid var(--border-soft)",
        borderRadius: 5,
        padding: "8px 9px",
        ...style,
      }}
    >
      {children}
    </pre>
  );
}
