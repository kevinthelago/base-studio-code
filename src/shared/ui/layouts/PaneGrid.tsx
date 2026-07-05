// PaneGrid — the Layouts-tier template for a CSS-grid of N equal panes (#2197 slice 2). The
// standardized "grid of panes" skeleton: a `cols × rows` CSS grid that flexes to fill its parent,
// with a uniform gap + padding, hosting N pane cells. It owns the grid frame — the track template,
// the gap/padding, and the flex/min-height that lets the grid share a flex column — so a pane-grid
// page brings only its pane cells and the `cols`/`rows` count.
//
// The canonical consumer is the Console (`app/console`), which mounts ONE PaneGrid per tab and keeps
// every tab's grid alive across switches: `hidden` renders the grid `display:none` WITHOUT unmounting
// it (so background-tab xterm/PTY listeners survive), and a fullscreened pane collapses the caller's
// grid to 1×1 while the non-focused cells hide themselves. Sits on the Box primitive in the same
// inline-style/token idiom; the escape hatches (gap/pad/style) cover the rare deliberate difference.
import type { CSSProperties, ReactNode } from "react";
import { Box } from "@/shared/ui/layout/Box";

export interface PaneGridProps {
  /** The pane cells — N children laid out across the grid tracks (cols × rows). */
  children: ReactNode;
  /** Column track count → `repeat(cols, 1fr)`. Clamped to ≥ 1. */
  cols: number;
  /** Row track count → `repeat(rows, 1fr)`. Clamped to ≥ 1. */
  rows: number;
  /** Gap between cells in px. Default 8. */
  gap?: number;
  /** Grid inner padding in px. Default 10. */
  pad?: number;
  /**
   * Render the grid `display:none` but keep it MOUNTED (children stay alive). Lets a consumer stack
   * several grids and flip visibility without disposing pane state (the Console's cross-tab mount).
   * Default false.
   */
  hidden?: boolean;
  /** Extra class on the root (a page scoping hook, e.g. the Console's `.console-grid`). */
  className?: string;
  /** Escape hatch for a deliberate root override. */
  style?: CSSProperties;
}

export function PaneGrid({ children, cols, rows, gap = 8, pad = 10, hidden = false, className, style }: PaneGridProps) {
  const c = Math.max(1, cols);
  const r = Math.max(1, rows);
  return (
    <Box
      className={className}
      style={{
        flex: 1, minHeight: 0,
        display: hidden ? "none" : "grid",
        gridTemplateColumns: `repeat(${c}, 1fr)`,
        gridTemplateRows: `repeat(${r}, 1fr)`,
        gap, padding: pad,
        ...style,
      }}
    >
      {children}
    </Box>
  );
}
