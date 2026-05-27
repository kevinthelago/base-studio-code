// Focus policy for console panes.

export type PaneStatus = "run" | "on" | "idle";

/**
 * Whether replying to the focused agent — it just went idle -> run — should
 * auto-advance focus to the next waiting pane (complete an interaction, move on).
 * Only the focused pane's reply triggers it; a background pane resuming on its
 * own must not move the cursor.
 */
export function shouldAdvanceOnReply(
  prevStatus: PaneStatus,
  status: PaneStatus,
  paneIdx: number,
  focusedIdx: number,
): boolean {
  return status === "run" && prevStatus === "idle" && focusedIdx >= 0 && paneIdx === focusedIdx;
}

/**
 * Resolve the next `fullscreenPaneIdx` when toggling maximize/minimize on a pane.
 * Shared by the header button (via Console's handler) and the Ctrl+Shift+F hotkey
 * so both follow identical maximize ⇄ restore semantics.
 *
 * @param targetIdx the pane to act on (e.g. the focused pane); negative means
 *   nothing is selected.
 * @param currentFullscreenIdx the pane currently maximized, or -1 for none.
 * @returns -1 to restore the grid (target was already maximized), the target
 *   index to maximize it, or `null` when there is no pane to act on (no-op).
 */
export function nextFullscreen(targetIdx: number, currentFullscreenIdx: number): number | null {
  if (targetIdx < 0) return null;
  return currentFullscreenIdx === targetIdx ? -1 : targetIdx;
}
