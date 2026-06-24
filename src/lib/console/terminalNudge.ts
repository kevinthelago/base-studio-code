// Resize-nudge sizing (#1221). Pure so the transient-then-restore PTY sizes are unit-testable
// without spinning up xterm in jsdom. The nudge forces the Claude CLI's TUI to repaint by briefly
// shrinking the PTY by one COLUMN — a guaranteed SIGWINCH — then settling back to the true fitted
// size; a column delta (not rows) avoids the #1158 growing-host input clip box.

export interface NudgeSizes {
  /** The transient size that triggers the SIGWINCH (one column narrower). */
  transient: { cols: number; rows: number };
  /** The real fitted size to settle back to — net dimensions unchanged after the nudge. */
  restore: { cols: number; rows: number };
}

/** The two PTY sizes a resize-nudge issues. Returns `null` when there's nothing safe to shrink
 *  (cols ≤ 1), so the caller skips the nudge rather than resizing to a zero/negative width. */
export function nudgeSizes(cols: number, rows: number): NudgeSizes | null {
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 1) return null;
  return { transient: { cols: cols - 1, rows }, restore: { cols, rows } };
}
