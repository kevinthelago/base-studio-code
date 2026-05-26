// Pure logic for the chained-digit console pane selector (Ctrl+Shift + digits).

/**
 * Commit window after the last digit while Ctrl+Shift is held (ms). The buffer
 * also commits immediately when Ctrl/Shift is released, so single-digit
 * selections feel instant — this timeout only matters if the modifier is held.
 */
export const PANE_SELECT_COMMIT_MS = 800;

/**
 * Resolve a typed digit buffer (accumulated while Ctrl+Shift is held) to a
 * 0-based pane index, or null when it doesn't name a real pane in the grid.
 *
 * Pane numbers are 1-based as typed (1 → first pane), so "13" → index 12. A
 * leading zero is rejected so "0"/"01" never select pane 0, and numbers beyond
 * the active grid are ignored.
 *
 * @param buffer digits typed so far, e.g. "1" or "13".
 * @param paneCount number of panes in the active tab's grid.
 */
export function resolvePaneFromBuffer(buffer: string, paneCount: number): number | null {
  if (!/^\d+$/.test(buffer)) return null;
  if (buffer[0] === "0") return null;       // leading zero → no pane 0
  const idx = parseInt(buffer, 10) - 1;     // 1-based → 0-based
  if (idx < 0 || idx >= paneCount) return null;
  return idx;
}
