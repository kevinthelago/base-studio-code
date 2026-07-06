// Terminal tuning shared across console panes.

import { clamp } from "@/shared/lib/core/math";

/**
 * Scrollback line budget for one pane, scaled down as the total mounted-pane
 * count across ALL tabs grows.
 *
 * xterm retains every scrollback line in renderer memory, so N panes each
 * holding a deep buffer multiplies fast — a 4×4 triage (16 panes) at a flat
 * 10k lines is ~160k buffered lines and a prime suspect for renderer OOM.
 * #187 made every tab's panes stay mounted (so xterm + scrollback survive tab
 * switches), which means a 2-tab × 16-pane workspace is now 32 mounted panes,
 * not 16. The buckets below preserve the single-tab budgets so existing
 * workflows don't regress, then extend downward for the cross-tab reality.
 *
 * @param paneCount total panes mounted across every tab in the workspace.
 */
export function scrollbackForPaneCount(paneCount: number): number {
  if (paneCount <= 1)  return 10000;
  if (paneCount <= 4)  return 6000;
  if (paneCount <= 9)  return 3000;
  if (paneCount <= 16) return 1500; // single 4×4 tab — unchanged
  if (paneCount <= 32) return 1000; // ~two heavy tabs
  return 500;                       // 33+ — large fleets across many tabs
}

/**
 * Sum every tab's `cols × rows` so {@link scrollbackForPaneCount} can size each
 * pane's buffer against the workspace-wide load, not just its own tab's grid.
 * Layout values that don't parse fall back to a 1×1 cell.
 */
export function totalMountedPaneCount(tabs: ReadonlyArray<{ layout: string }>): number {
  return tabs.reduce((sum, tab) => {
    const [c, r] = tab.layout.split("×").map(Number);
    return sum + (c || 1) * (r || 1);
  }, 0);
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
  return clamp(Math.round(size), MIN_TERMINAL_FONT_SIZE, MAX_TERMINAL_FONT_SIZE);
}

/**
 * Resolve the next terminal font size when zooming by `steps` (e.g. +1 in, -1 out),
 * clamped to the legible range. Stepping past a bound is a no-op (stays clamped).
 */
export function adjustFontSize(current: number, steps: number): number {
  return clampFontSize(current + steps * TERMINAL_FONT_STEP);
}
