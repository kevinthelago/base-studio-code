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
