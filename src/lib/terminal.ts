// Terminal tuning shared across console panes.

/**
 * Scrollback line budget for a pane, scaled down as the grid grows.
 *
 * xterm retains every scrollback line in renderer memory, so N panes each
 * holding a deep buffer multiplies fast — a 4×4 triage (16 panes) at a flat
 * 10k lines is ~160k buffered lines and a prime suspect for renderer OOM.
 * Small grids keep a generous buffer; large grids trade history for memory.
 *
 * @param paneCount number of panes mounted in the current tab's grid.
 */
export function scrollbackForPaneCount(paneCount: number): number {
  if (paneCount <= 1) return 10000;
  if (paneCount <= 4) return 6000;
  if (paneCount <= 9) return 3000;
  return 1500; // 16-pane (4×4) and beyond
}

// ── Terminal font zoom (Ctrl++ / Ctrl+- / Ctrl+0) ──────────────────────────────

/** Default xterm font size (px) for console panes — matches the unzoomed baseline. */
export const DEFAULT_TERMINAL_FONT_SIZE = 12;
/** Legible floor: below this, rows fit but the text isn't worth reading. */
export const MIN_TERMINAL_FONT_SIZE = 8;
/** Practical ceiling so a single pane can't swallow the whole grid. */
export const MAX_TERMINAL_FONT_SIZE = 28;
/** Pixels added/removed per zoom step. */
export const TERMINAL_FONT_STEP = 1;

/**
 * Clamp a font size to the legible range, rounded to whole px. Non-finite input
 * (corrupt persisted value) falls back to the default rather than breaking xterm.
 */
export function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_TERMINAL_FONT_SIZE;
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(size)));
}

/**
 * Resolve the next terminal font size when zooming by `steps` (e.g. +1 in, -1 out),
 * clamped to the legible range. Stepping past a bound is a no-op (stays clamped).
 */
export function adjustFontSize(current: number, steps: number): number {
  return clampFontSize(current + steps * TERMINAL_FONT_STEP);
}
